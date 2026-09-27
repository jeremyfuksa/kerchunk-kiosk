// kerchunk-dsp engine: one DSP thread, clocked by input samples (now = samples/rate).
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <vector>

#include "audio.hpp"
#include "channelizer.hpp"
#include "closecall.hpp"
#include "ctcss.hpp"
#include "dcs.hpp"
#include "demod.hpp"
#include "meters.hpp"
#include "protocol.hpp"
#include "scanner.hpp"
#include "subaudio.hpp"

namespace kc {
struct EngineOptions {
  int rate = 2'400'000;
  int lanes = DEFAULT_LANES;                 // lane slots, 1..MAX_LANES (CLI --lanes)
  Scanner::Params squelch{};
  bool close_call = false;
  bool same = false;
  double speaker_lpf_hz = SPEAKER_LPF_HZ;   // speaker audio LPF cutoff (CLI --audio-lpf-hz)
  double speaker_hpf_hz = SPEAKER_HPF_HZ;   // FM speaker HPF cutoff, 0 = off (CLI --audio-hpf-hz)
  double am_gain_db = 0.0;                   // AM speaker gain offset vs AM_GAIN, dB (CLI --am-gain-db;
                                             // balances airband loudness against FM by ear;
                                             // it is the AM pre-gain INTO the speaker AGC)
  AgcParams agc{};                           // speaker AGC (CLI --agc-*)
  double limiter_ceiling = LIMITER_CEILING;        // speaker peak limiter (CLI --limiter-ceiling)
  double limiter_release_ms = LIMITER_RELEASE_MS;  // (CLI --limiter-release-ms)
};

class Engine {
 public:
  using Emit = std::function<void(const nlohmann::json&)>;
  using Pcm = std::function<void(const int16_t*, int)>;
  Engine(const EngineOptions& o, Emit emit, Pcm speaker, Pcm tee, Pcm same);
  void command(const Command& c);
  void push_u8(const uint8_t* iq, size_t nsamples);
  double now() const { return (double)samples_ / opt_.rate; }
  bool quit() const { return quit_; }
  const Scanner& scanner() const { return sc_; }   // read-only: slot assignment (tests, diagnostics)
  // Input the DSP never saw (ring overrun, or retune discard): advance the clock by n samples and,
  // if a window is live, restart the channelizer stream so the gap can't smear across hops.
  // dropped=true counts toward power.drops and the rate-limited overrun log.
  void note_gap(long long nsamples, bool dropped);

 private:
  void tune(const TuneCmd& t);
  void on_hop(const cf* lanes, int per, const cf* raw, int raw_n);
  void poll();
  void reset_lane(int i);
  void reset_subaudio(int i);   // decimator + both sub-audible detectors (cheap when idle)
  void sync_speaker();   // point the speaker path at the scanner's current audible lane + gate
  void sync_active();
  void flush_audio();                // out48_ -> speaker + tee (s16)
  void speak_silence(long long n);   // run the speaker path on silence for n IQ samples of wall time    // channelizer lane mask: parked slots off, except one the speaker still feeds

  EngineOptions opt_;
  Emit emit_;
  Pcm speaker_, tee_, same_;
  Channelizer ch_;
  Scanner sc_;
  SpeakerPath spk_;
  SamePath same_path_;
  std::unique_ptr<CloseCall> cc_;
  std::vector<ChunkPower> power_;
  std::vector<FmDiscriminator> disc_;
  std::vector<QuietingMeter> quiet_;
  // Sub-audible squelch, fed only while Scanner::wants_tone(lane): one shared decimator per lane
  // feeds both detectors.
  std::vector<SubaudioDecimator> sub_;
  std::vector<CtcssDetector> ctcss_;
  std::vector<DcsDetector> dcs_;
  std::vector<double> dcs_seen_;   // now() of the lane's last decoded DCS code (-1 = none since reset)
  std::vector<float> sub_buf_;   // one hop of SUBAUDIO_RATE samples (reused per lane)
  std::vector<std::vector<float>> disc_buf_;
  std::vector<LaneReading> readings_;
  std::vector<float> out48_;
  std::vector<int16_t> s16_, same16_;
  double center_ = 0;
  bool tuned_ = false, cc_on_ = false, quit_ = false;
  // samples_ is the hop-granular event clock (advanced as hops are processed); pushed_ counts every
  // input sample, including a partial hop that a retune discards -- tune() resyncs samples_ to it.
  long long samples_ = 0, pushed_ = 0, lane_samples_ = 0, next_poll_ = CHUNK_SAMPLES;
  long long gap_lane_acc_ = 0;   // speak_silence remainder (IQ samples x LANE_RATE, mod rate)
  long polls_ = 0;
  long long drops_since_power_ = 0;
  double last_drop_log_ = -1e9;
};
}  // namespace kc
