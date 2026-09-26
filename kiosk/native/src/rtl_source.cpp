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

std::string RtlSource::who() const {
  return !o_.serial.empty() ? "serial " + o_.serial : "index " + std::to_string(o_.index >= 0 ? o_.index : 0);
}

bool RtlSource::open(std::string& err, const std::function<bool()>& should_stop) {
  const std::string pre = "failed to open RTL-SDR (" + who() + "): ";
  int index = o_.index >= 0 ? o_.index : 0;
  if (!o_.serial.empty()) {
    index = rtlsdr_get_index_by_serial(o_.serial.c_str());
    if (index < 0) { err = pre + "not found"; return false; }
  }
  const auto t0 = std::chrono::steady_clock::now();
  int rc;
  // The previous helper may still hold the dongle while it exits: retry briefly before failing.
  while ((rc = rtlsdr_open(&dev_, (uint32_t)index)) < 0) {
    dev_ = nullptr;
    if (should_stop && should_stop()) { err = "aborted"; return false; }
    if (std::chrono::steady_clock::now() - t0 > std::chrono::duration<double>(BUSY_RETRY_S)) {
      err = pre + "rtlsdr_open rc=" + std::to_string(rc);
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  if ((rc = rtlsdr_set_sample_rate(dev_, (uint32_t)o_.rate)) < 0) {
    err = pre + "set_sample_rate(" + std::to_string(o_.rate) + ") rc=" + std::to_string(rc);
    rtlsdr_close(dev_);
    dev_ = nullptr;
    return false;
  }
  if (o_.gain == "auto") {
    if ((rc = rtlsdr_set_tuner_gain_mode(dev_, 0)) < 0) log_("rtlsdr_set_tuner_gain_mode(auto) failed: rc=" + std::to_string(rc));
  } else {
    if ((rc = rtlsdr_set_tuner_gain_mode(dev_, 1)) < 0) log_("rtlsdr_set_tuner_gain_mode(manual) failed: rc=" + std::to_string(rc));
    const int tenths = (int)std::lround(std::atof(o_.gain.c_str()) * 10.0);
    if ((rc = rtlsdr_set_tuner_gain(dev_, tenths)) < 0) log_("rtlsdr_set_tuner_gain(" + o_.gain + " dB) failed: rc=" + std::to_string(rc));
  }
  if ((rc = rtlsdr_reset_buffer(dev_)) < 0) log_("rtlsdr_reset_buffer failed: rc=" + std::to_string(rc));
  return true;
}

void RtlSource::publish_acc() {
  const uint32_t n = acc_n_ & ~1u;   // whole I/Q pairs only; an odd byte carries into the next block
  if (n) {
    const bool ok = ring_.try_emplace([&](IqBlock& b) {
      b.gen = acc_.gen;
      b.n = n;
      std::memcpy(b.data.data(), acc_.data.data(), n);
    });
    if (!ok) dropped_.fetch_add(n / 2, std::memory_order_relaxed);   // DSP fell behind
  }
  if (acc_n_ & 1u) {
    acc_.data[0] = acc_.data[acc_n_ - 1];
    acc_n_ = 1;
  } else {
    acc_n_ = 0;
  }
}

void RtlSource::on_samples(unsigned char* buf, uint32_t len, void* ctx) {
  auto* self = static_cast<RtlSource*>(ctx);
  self->last_rx_ns_.store(mono_ns(), std::memory_order_relaxed);
  const uint32_t g = self->gen_.load(std::memory_order_acquire);
  // A retune landed since the last transfer: flush the partial block early so no block ever mixes
  // generations (LiveLoop discards/keeps whole blocks by generation).
  if (self->acc_n_ >= 2 && self->acc_.gen != g) self->publish_acc();
  self->acc_.gen = g;
  const uint32_t cap = (uint32_t)self->block_bytes_;
  for (uint32_t off = 0; off < len;) {
    const uint32_t take = std::min(cap - self->acc_n_, len - off);
    std::memcpy(self->acc_.data.data() + self->acc_n_, buf + off, take);
    self->acc_n_ += take;
    off += take;
    if (self->acc_n_ == cap) self->publish_acc();
  }
}

void RtlSource::start() {
  running_ = true;
  async_done_ = false;
  last_rx_ns_ = mono_ns();
  t_ = std::thread([this] {
    const int rc = rtlsdr_read_async(dev_, &RtlSource::on_samples, this, RTL_BUF_NUM, RTL_BUF_LEN);
    // Returning while still running = the device went away (USB loss); the stall check then exits 3.
    if (running_.load()) log_("rtlsdr_read_async returned rc=" + std::to_string(rc) + " while running (device lost?)");
    async_done_ = true;
  });
}

void RtlSource::stop() {
  if (running_.exchange(false)) {
    // rtlsdr_cancel_async is a no-op until read_async has reached its RUNNING state, so a stop()
    // right after start() must keep cancelling until read_async actually returns.
    while (!async_done_.load()) {
      rtlsdr_cancel_async(dev_);
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (t_.joinable()) t_.join();
  }
  if (dev_) { rtlsdr_close(dev_); dev_ = nullptr; }
}

bool RtlSource::set_center(double hz) {
  if (dev_) {
    const auto f = (uint32_t)std::llround(hz);
    int rc = -1;
    for (int i = 0; i < RETUNE_ATTEMPTS && rc < 0; i++) {
      if (i) std::this_thread::sleep_for(std::chrono::milliseconds(RETUNE_RETRY_MS));
      rc = rtlsdr_set_center_freq(dev_, f);
      if (rc < 0) log_("rtlsdr_set_center_freq(" + std::to_string(f) + ") failed: rc=" + std::to_string(rc) +
                       " (try " + std::to_string(i + 1) + "/" + std::to_string(RETUNE_ATTEMPTS) + ")");
    }
    if (rc < 0) return false;   // generation untouched: nothing new is coming from this center
  }
  gen_.fetch_add(1, std::memory_order_acq_rel);
  return true;
}

double RtlSource::seconds_since_rx() const { return (mono_ns() - last_rx_ns_.load()) / 1e9; }
}  // namespace kc
