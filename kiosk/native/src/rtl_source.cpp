#include "rtl_source.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace kc {
namespace {
long long mono_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
}  // namespace

RtlSource::RtlSource(Options o, LogFn log)
    : o_(std::move(o)), log_(std::move(log)),
      block_bytes_(std::min<size_t>(IQ_BLOCK_BYTES, (size_t)o_.rate / 100 * 2)) {}

RtlSource::~RtlSource() { stop(); }

bool RtlSource::open(std::string& err) {
  int index = o_.index >= 0 ? o_.index : 0;
  if (!o_.serial.empty()) {
    index = rtlsdr_get_index_by_serial(o_.serial.c_str());
    if (index < 0) { err = "no RTL-SDR with serial " + o_.serial; return false; }
  }
  const auto t0 = std::chrono::steady_clock::now();
  int rc;
  // The previous helper may still hold the dongle while it exits: retry briefly before failing.
  while ((rc = rtlsdr_open(&dev_, (uint32_t)index)) < 0) {
    if (std::chrono::steady_clock::now() - t0 > std::chrono::duration<double>(BUSY_RETRY_S)) {
      err = "rtlsdr_open(" + std::to_string(index) + ") failed: " + std::to_string(rc);
      dev_ = nullptr;
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  if (rtlsdr_set_sample_rate(dev_, (uint32_t)o_.rate) < 0) { err = "set_sample_rate failed"; return false; }
  if (o_.gain == "auto") {
    rtlsdr_set_tuner_gain_mode(dev_, 0);
  } else {
    rtlsdr_set_tuner_gain_mode(dev_, 1);
    rtlsdr_set_tuner_gain(dev_, (int)std::lround(std::atof(o_.gain.c_str()) * 10.0));
  }
  rtlsdr_reset_buffer(dev_);
  return true;
}

void RtlSource::on_samples(unsigned char* buf, uint32_t len, void* ctx) {
  auto* self = static_cast<RtlSource*>(ctx);
  self->last_rx_ns_.store(mono_ns(), std::memory_order_relaxed);
  const uint32_t g = self->gen_.load(std::memory_order_acquire);
  for (uint32_t off = 0; off < len;) {
    const uint32_t n = (uint32_t)std::min<size_t>(self->block_bytes_, len - off) & ~1u;
    if (n == 0) break;
    const bool ok = self->ring_.try_emplace([&](IqBlock& b) {
      b.gen = g;
      b.n = n;
      std::memcpy(b.data.data(), buf + off, n);
    });
    if (!ok) self->dropped_.fetch_add(n / 2, std::memory_order_relaxed);   // DSP fell behind
    off += n;
  }
}

void RtlSource::start() {
  running_ = true;
  last_rx_ns_ = mono_ns();
  t_ = std::thread([this] { rtlsdr_read_async(dev_, &RtlSource::on_samples, this, RTL_BUF_NUM, RTL_BUF_LEN); });
}

void RtlSource::stop() {
  if (running_.exchange(false)) {
    rtlsdr_cancel_async(dev_);
    if (t_.joinable()) t_.join();
  }
  if (dev_) { rtlsdr_close(dev_); dev_ = nullptr; }
}

void RtlSource::set_center(double hz) {
  if (dev_ && rtlsdr_set_center_freq(dev_, (uint32_t)std::llround(hz)) < 0) log_("rtlsdr_set_center_freq failed");
  gen_.fetch_add(1, std::memory_order_acq_rel);
}

double RtlSource::seconds_since_rx() const { return (mono_ns() - last_rx_ns_.load()) / 1e9; }
}  // namespace kc
