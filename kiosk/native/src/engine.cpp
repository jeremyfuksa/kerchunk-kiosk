#include "engine.hpp"

#include <cmath>
#include <string>
#include <type_traits>

namespace kc {
using nlohmann::json;

Engine::Engine(const EngineOptions& o, Emit emit, Pcm speaker, Pcm tee, Pcm same)
    : opt_(o), emit_(std::move(emit)), speaker_(std::move(speaker)), tee_(std::move(tee)), same_(std::move(same)),
      ch_(o.rate), sc_(o.squelch, [this](const json& j) { emit_(j); }), spk_(o.speaker_lpf_hz),
      power_(MAX_LANES), disc_(MAX_LANES), quiet_(MAX_LANES),
      disc_buf_(MAX_LANES, std::vector<float>(Channelizer::kLaneSamplesPerHop)), readings_(MAX_LANES) {
  if (o.close_call) cc_ = std::make_unique<CloseCall>(o.rate);   // FFTW planning on this (the DSP) thread
  ch_.set_lanes(std::vector<double>(MAX_LANES, 0.0));
  out48_.reserve(256);
}

void Engine::reset_lane(int i) {
  power_[i].reset();
  disc_[i].reset();
  quiet_[i].reset();
}

void Engine::sync_speaker() {
  const int a = sc_.audible();
  spk_.set_source(a, a >= 0 && sc_.lane(a).am);
  spk_.set_gain(sc_.gate());
}

void Engine::command(const Command& c) {
  std::visit([this](const auto& cmd) {
    using T = std::decay_t<decltype(cmd)>;
    if constexpr (std::is_same_v<T, TuneCmd>) tune(cmd);
    else if constexpr (std::is_same_v<T, KnownCmd>) { if (cc_) cc_->set_known(cmd.known_hz); }
    else if constexpr (std::is_same_v<T, SkipCmd>) {
      long long f = sc_.skip(cmd.holdoff_s, now());
      if (f && cc_) cc_->cooldown(f, now() + cmd.holdoff_s);
      sync_speaker();
    }
    else if constexpr (std::is_same_v<T, AlertUnmuteCmd>) {
      sc_.alert_unmute(cmd.id, cmd.hold_s, now());
      sync_speaker();
    }
    else if constexpr (std::is_same_v<T, QuitCmd>) quit_ = true;
  }, c);
}

void Engine::tune(const TuneCmd& t) {
  samples_ = pushed_;   // reset_stream() below drops a partial hop; the clock still counts it
  center_ = t.center_hz;
  const double limit = opt_.rate / 2.0 - LANE_RATE / 2.0;
  std::vector<ChannelCmd> ok;
  for (const auto& c : t.channels) {
    const double off = c.freq_hz - center_;
    if (!std::isfinite(off) || std::fabs(off) > limit) {
      emit_({{"ev", "log"}, {"msg", "channel " + c.id + " is outside the tuned window; dropped"}});
      continue;
    }
    ok.push_back(c);
  }
  sc_.tune(center_, ok, t.monitor);
  std::vector<double> offsets(MAX_LANES, 0.0);
  for (int i = 0; i < MAX_LANES; i++)
    if (!sc_.lane(i).parked()) offsets[i] = sc_.lane(i).freq_hz - center_;
  ch_.reset_stream();
  ch_.set_lanes(offsets);
  for (int i = 0; i < MAX_LANES; i++) reset_lane(i);
  spk_.cut();   // retune: fade the last emitted sample out (GR faded before a retune), no step
  same_path_.reset();
  if (cc_) {
    cc_->reset(center_);
    cc_->set_known(t.known_hz);
    cc_->set_db(t.close_call_db);
  }
  cc_on_ = cc_ && t.close_call && !t.monitor;
  sync_speaker();
  lane_samples_ = 0;
  next_poll_ = CHUNK_SAMPLES;
  polls_ = 0;
  tuned_ = true;
}

void Engine::push_u8(const uint8_t* iq, size_t nsamples) {
  pushed_ += (long long)nsamples;
  if (!tuned_) { samples_ += (long long)nsamples; return; }
  ch_.push_u8(iq, nsamples, [this](const cf* lanes, int, int per, const cf* raw, int raw_n) { on_hop(lanes, per, raw, raw_n); });
}

void Engine::on_hop(const cf* lanes, int per, const cf* raw, int raw_n) {
  samples_ += raw_n;
  for (int i = 0; i < MAX_LANES; i++) {
    const LaneState& L = sc_.lane(i);
    if (L.parked()) continue;
    const cf* y = lanes + i * per;
    power_[i].push(y, per);
    float* db = disc_buf_[i].data();
    for (int d = 0; d < per; d++) {
      db[d] = disc_[i].step(y[d]);
      quiet_[i].push(db[d]);
    }
    if (L.background && opt_.same) {
      same16_.clear();
      same_path_.push(db, per, same16_);
      if (same_ && !same16_.empty()) same_(same16_.data(), (int)same16_.size());
    }
  }
  out48_.clear();
  const int f = spk_.feeding_lane();
  if (f >= 0 && sc_.lane(f).parked()) {
    // Scanner::skip parks an audible Close Call slot at once, but the speaker is still fading it
    // out. Parking doesn't move the channelizer offset, so the slot's samples are still the old
    // channel: keep its discriminator running (no meters) so the fade runs on real audio, not
    // zeros -- a fade over zeros is a hard cut, an audible click.
    const cf* y = lanes + f * per;
    float* db = disc_buf_[f].data();
    for (int d = 0; d < per; d++) db[d] = disc_[f].step(y[d]);
  }
  if (f >= 0) spk_.process(lanes + f * per, disc_buf_[f].data(), per, out48_);
  else spk_.process(nullptr, nullptr, per, out48_);
  if (!out48_.empty()) {
    if (speaker_) { to_s16(out48_.data(), (int)out48_.size(), SPEAKER_S16_SCALE, s16_); speaker_(s16_.data(), (int)s16_.size()); }
    if (tee_) { to_s16(out48_.data(), (int)out48_.size(), TEE_S16_SCALE, s16_); tee_(s16_.data(), (int)s16_.size()); }
  }
  if (cc_on_) cc_->push_raw(raw, raw_n);
  lane_samples_ += per;
  while (lane_samples_ >= next_poll_) {
    poll();
    next_poll_ += CHUNK_SAMPLES;
  }
}

void Engine::poll() {
  polls_++;
  for (int i = 0; i < MAX_LANES; i++)
    readings_[i] = {power_[i].fast_db(), power_[i].slow_db(), quiet_[i].db(), quiet_[i].ready()};
  sc_.poll(now(), readings_, spk_.speech_db());
  sync_speaker();
  if (polls_ % POWER_EVERY_POLLS == 0)
    emit_({{"ev", "power"}, {"levels", sc_.power_levels(readings_)}, {"noise", sc_.noise_levels(readings_)}});
  if (cc_on_ && polls_ % CC_EVERY_POLLS == 0) {
    if (auto hit = cc_->check(now(), sc_.assigned_freqs())) {
      // Window check first: raster rounding can push an edge-bin hit past the lane limit, and a
      // lane must never carry a cc_ id the channelizer can't point at.
      const double off = (double)*hit - center_;
      if (std::fabs(off) > opt_.rate / 2.0 - LANE_RATE / 2.0) {
        emit_({{"ev", "log"}, {"msg", "close call " + std::to_string(*hit) + " outside lane window; ignored"}});
      } else {
        emit_({{"ev", "closecall"}, {"freqHz", *hit}});
        const int s = sc_.assign_cc(*hit);
        if (s >= 0) {
          ch_.set_lane_offset(s, off);
          reset_lane(s);
        }
      }
    }
  }
}
}  // namespace kc
