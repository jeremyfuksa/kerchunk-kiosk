#include "engine.hpp"

#include <algorithm>
#include <cmath>
#include <string>
#include <type_traits>

namespace kc {
using nlohmann::json;

Engine::Engine(const EngineOptions& o, Emit emit, Pcm speaker, Pcm tee, Pcm same)
    : opt_(o), emit_(std::move(emit)), speaker_(std::move(speaker)), tee_(std::move(tee)), same_(std::move(same)),
      ch_(o.rate), sc_(o.squelch, [this](const json& j) { emit_(j); }, o.lanes), spk_(o.speaker_lpf_hz, (float)(AM_GAIN * std::pow(10.0, o.am_gain_db / 20.0)), o.agc, o.limiter_ceiling,
           o.limiter_release_ms, o.speaker_hpf_hz),
      power_(o.lanes), disc_(o.lanes), quiet_(o.lanes), sub_(o.lanes), ctcss_(o.lanes), dcs_(o.lanes), dcs_seen_(o.lanes, -1.0),
      sub_buf_(SubaudioDecimator::max_out(Channelizer::kLaneSamplesPerHop)),
      disc_buf_(o.lanes, std::vector<float>(Channelizer::kLaneSamplesPerHop)), readings_(o.lanes) {
  if (o.close_call) cc_ = std::make_unique<CloseCall>(o.rate);   // FFTW planning on this (the DSP) thread
  ch_.set_lanes(std::vector<double>(opt_.lanes, 0.0));
  out48_.reserve(256);
}

void Engine::reset_lane(int i) {
  power_[i].reset();
  disc_[i].reset();
  quiet_[i].reset();
  reset_subaudio(i);
}

void Engine::reset_subaudio(int i) {
  sub_[i].reset();
  ctcss_[i].reset();
  dcs_[i].reset();
  dcs_seen_[i] = -1;
}

void Engine::sync_speaker() {
  const int a = sc_.audible();
  spk_.set_source(a, a >= 0 && sc_.lane(a).am);
  spk_.set_gain(sc_.gate());
  sync_active();
}

void Engine::sync_active() {
  // Parked slots skip their channelizer extract + IFFT -- except a parked slot the speaker is
  // still fading out (on_hop keeps its discriminator running on the old channel's samples).
  const int f = spk_.feeding_lane();
  for (int i = 0; i < opt_.lanes; i++) ch_.set_lane_active(i, !sc_.lane(i).parked() || i == f);
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
  std::vector<double> offsets(opt_.lanes, 0.0);
  for (int i = 0; i < opt_.lanes; i++)
    if (!sc_.lane(i).parked()) offsets[i] = sc_.lane(i).freq_hz - center_;
  ch_.reset_stream();
  ch_.set_lanes(offsets);
  for (int i = 0; i < opt_.lanes; i++) reset_lane(i);
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

void Engine::flush_audio() {
  if (out48_.empty()) return;
  if (speaker_) { to_s16(out48_.data(), (int)out48_.size(), SPEAKER_S16_SCALE, s16_); speaker_(s16_.data(), (int)s16_.size()); }
  if (tee_) { to_s16(out48_.data(), (int)out48_.size(), TEE_S16_SCALE, s16_); tee_(s16_.data(), (int)s16_.size()); }
}

void Engine::speak_silence(long long n) {
  // A gap (retune settle / old-center discard / IQ overrun) produces no hops, so without this the
  // speaker ring starves for the gap's length every group hop (~20-35 ms; the audio-loss counter
  // measured ~430 ms/min). Run the speaker path on silence for the same wall time instead: its
  // filters decay naturally and the output clock stays continuous.
  gap_lane_acc_ += n * LANE_RATE;
  long long lane_n = gap_lane_acc_ / opt_.rate;
  gap_lane_acc_ %= opt_.rate;
  while (lane_n > 0) {
    const int k = (int)std::min<long long>(lane_n, Channelizer::kLaneSamplesPerHop);
    out48_.clear();
    spk_.process(nullptr, nullptr, k, out48_);
    flush_audio();
    lane_n -= k;
  }
}

void Engine::note_gap(long long n, bool dropped) {
  if (n <= 0) return;
  pushed_ += n;
  if (tuned_) speak_silence(n);
  // Resync the clock to pushed_, same as tune(): reset_stream() below throws away whatever partial
  // hop was buffered, and that partial hop's samples were already counted in pushed_ (by push_u8)
  // before this gap landed, so leaving samples_ hop-lagged would lose them off the clock forever.
  samples_ = pushed_;
  if (tuned_) ch_.reset_stream();
  if (!dropped) return;
  drops_since_power_ += n;
  if (now() - last_drop_log_ >= DROP_LOG_EVERY_S) {
    last_drop_log_ = now();
    emit_({{"ev", "log"}, {"msg", "dropped " + std::to_string(n) + " IQ samples (DSP overrun)"}});
  }
}

void Engine::push_u8(const uint8_t* iq, size_t nsamples) {
  pushed_ += (long long)nsamples;
  if (!tuned_) { samples_ += (long long)nsamples; return; }
  ch_.push_u8(iq, nsamples, [this](const cf* lanes, int, int per, const cf* raw, int raw_n) { on_hop(lanes, per, raw, raw_n); });
}

void Engine::on_hop(const cf* lanes, int per, const cf* raw, int raw_n) {
  samples_ += raw_n;
  for (int i = 0; i < opt_.lanes; i++) {
    const LaneState& L = sc_.lane(i);
    if (L.parked()) continue;
    const cf* y = lanes + i * per;
    power_[i].push(y, per);
    float* db = disc_buf_[i].data();
    for (int d = 0; d < per; d++) {
      db[d] = disc_[i].step(y[d]);
      quiet_[i].push(db[d]);
    }
    if (sc_.wants_tone(i)) {
      const int ns = sub_[i].push(db, per, sub_buf_.data());
      ctcss_[i].push(sub_buf_.data(), ns);
      dcs_[i].push(sub_buf_.data(), ns);
    } else {
      reset_subaudio(i);   // cheap unless the lane just went idle
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
  flush_audio();
  if (cc_on_) cc_->push_raw(raw, raw_n);
  lane_samples_ += per;
  while (lane_samples_ >= next_poll_) {
    poll();
    next_poll_ += CHUNK_SAMPLES;
  }
}

void Engine::poll() {
  polls_++;
  for (int i = 0; i < opt_.lanes; i++) {
    // A DCS bitstream has spectral lines (multiples of 134.4/23 Hz) that pass for a CTCSS tone
    // (the CTCSS detector "hears" one on ~all 208 synthetic codes). While a DCS code is decoded --
    // or was within DCS_LOSS_MS, riding through bit errors -- any CTCSS reading is that artifact.
    const auto dcs = dcs_[i].code();
    if (dcs) dcs_seen_[i] = now();
    const bool dcs_lane = dcs_seen_[i] >= 0 && now() - dcs_seen_[i] <= DCS_LOSS_MS / 1000.0;
    readings_[i] = {power_[i].fast_db(), power_[i].slow_db(), quiet_[i].db(), quiet_[i].ready(),
                    dcs_lane ? std::nullopt : ctcss_[i].tone(), dcs};
  }
  sc_.poll(now(), readings_);
  sync_speaker();
  if (polls_ % POWER_EVERY_POLLS == 0) {
    json p = {{"ev", "power"}, {"levels", sc_.power_levels(readings_)}, {"noise", sc_.noise_levels(readings_)}};
    if (drops_since_power_ > 0) { p["drops"] = drops_since_power_; drops_since_power_ = 0; }
    emit_(p);
  }
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
          sync_active();
        }
      }
    }
  }
}
}  // namespace kc
