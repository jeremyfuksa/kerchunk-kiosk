#include "engine.hpp"

#include <cmath>
#include <string>
#include <type_traits>

namespace kc {
using nlohmann::json;

Engine::Engine(const EngineOptions& o, Emit emit, Pcm speaker, Pcm tee, Pcm same)
    : opt_(o), emit_(std::move(emit)), speaker_(std::move(speaker)), tee_(std::move(tee)), same_(std::move(same)),
      ch_(o.rate), sc_(o.squelch, [this](const json& j) { emit_(j); }),
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

void Engine::command(const Command& c) {
  std::visit([this](const auto& cmd) {
    using T = std::decay_t<decltype(cmd)>;
    if constexpr (std::is_same_v<T, TuneCmd>) tune(cmd);
    else if constexpr (std::is_same_v<T, KnownCmd>) { if (cc_) cc_->set_known(cmd.known_hz); }
    else if constexpr (std::is_same_v<T, SkipCmd>) {
      long long f = sc_.skip(cmd.holdoff_s, now());
      if (f && cc_) cc_->cooldown(f, now() + cmd.holdoff_s);
    }
    else if constexpr (std::is_same_v<T, AlertUnmuteCmd>) sc_.alert_unmute(cmd.id, cmd.hold_s, now());
    else if constexpr (std::is_same_v<T, QuitCmd>) quit_ = true;
  }, c);
}

void Engine::tune(const TuneCmd& t) {
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
  spk_.reset();   // retune: hard cut is fine, there is no audio context to preserve
  same_path_.reset();
  if (cc_) {
    cc_->reset(center_);
    cc_->set_known(t.known_hz);
    cc_->set_db(t.close_call_db);
  }
  cc_on_ = cc_ && t.close_call && !t.monitor;
  const int a = sc_.audible();
  spk_.set_source(a, a >= 0 && sc_.lane(a).am);
  spk_.set_gain(sc_.gate());
  lane_samples_ = 0;
  next_poll_ = CHUNK_SAMPLES;
  polls_ = 0;
  tuned_ = true;
}

void Engine::push_u8(const uint8_t* iq, size_t nsamples) {
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
  if (f >= 0 && !sc_.lane(f).parked()) spk_.process(lanes + f * per, disc_buf_[f].data(), per, out48_);
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
  const int a = sc_.audible();
  spk_.set_source(a, a >= 0 && sc_.lane(a).am);
  spk_.set_gain(sc_.gate());
  if (polls_ % POWER_EVERY_POLLS == 0)
    emit_({{"ev", "power"}, {"levels", sc_.power_levels(readings_)}, {"noise", sc_.noise_levels(readings_)}});
  if (cc_on_ && polls_ % CC_EVERY_POLLS == 0) {
    if (auto hit = cc_->check(now(), sc_.assigned_freqs())) {
      emit_({{"ev", "closecall"}, {"freqHz", *hit}});
      const int s = sc_.assign_cc(*hit);
      const double off = (double)*hit - center_;
      if (s >= 0 && std::fabs(off) <= opt_.rate / 2.0 - LANE_RATE / 2.0) {
        ch_.set_lane_offset(s, off);
        reset_lane(s);
      }
    }
  }
}
}  // namespace kc
