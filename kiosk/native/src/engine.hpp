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
#include "demod.hpp"
#include "meters.hpp"
#include "protocol.hpp"
#include "scanner.hpp"

namespace kc {
struct EngineOptions {
  int rate = 2'400'000;
  Scanner::Params squelch{};
  bool close_call = false;
  bool same = false;
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

 private:
  void tune(const TuneCmd& t);
  void on_hop(const cf* lanes, int per, const cf* raw, int raw_n);
  void poll();
  void reset_lane(int i);

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
  std::vector<std::vector<float>> disc_buf_;
  std::vector<LaneReading> readings_;
  std::vector<float> out48_;
  std::vector<int16_t> s16_, same16_;
  double center_ = 0;
  bool tuned_ = false, cc_on_ = false, quit_ = false;
  long long samples_ = 0, lane_samples_ = 0, next_poll_ = CHUNK_SAMPLES;
  long polls_ = 0;
};
}  // namespace kc
