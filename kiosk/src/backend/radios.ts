import { readFileSync, readdirSync } from "node:fs";

// Multi-SDR device addressing (ROADMAP Idea 10).
//
// SERIAL is the preferred identity now (see config schema `radios[].serial`):
// the dongles in service carry flashed EEPROM serials (KIOSK01/KIOSK03) and
// SoapySDR resolves `serial=KIOSK03` to the exact device. This PORT->index
// resolver is the FALLBACK for dongles with no usable serial.
//
// Why serial won: the port->index assumption below (sysfs port order ==
// libusb enumeration order) proved WRONG with two dongles on a hub — librtlsdr
// enumerated them in the opposite order, so a port-resolved index pointed at
// the OTHER dongle and the second helper crash-looped on usb_claim. Serial
// addressing is immune to that reordering.
//
// librtlsdr exposes devices by INDEX in libusb enumeration order. We sort by
// (busnum, port path, natural segment compare) and resolve fresh at every
// helper spawn, never cached — best-effort only; prefer serial.

// The RTL2832U family ships under multiple PIDs: 2838 (most clones, the
// RTL-SDR Blog sticks) and bare 2832 (older Nooelec Nano units — one of
// the operator's Nano 2s reports this).
const RTL_PRODUCTS = new Set(["2832", "2838"]);
const USB_ROOT = "/sys/bus/usb/devices";

export interface RtlDevice {
  port: string;     // sysfs port path, e.g. "1-1.2" — the stable identity
  busnum: number;
  devnum: number;
  index: number;    // librtlsdr device index, valid right now only
}

export function listRtlDevices(root = USB_ROOT, read?: (p: string) => string): RtlDevice[] {
  const rf = read ?? ((p: string) => readFileSync(p, "utf8"));
  const found: Array<Omit<RtlDevice, "index">> = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch { return []; }
  for (const e of entries) {
    try {
      if (!RTL_PRODUCTS.has(rf(`${root}/${e}/idProduct`).trim())) continue;
      found.push({
        port: e,
        busnum: Number(rf(`${root}/${e}/busnum`).trim()),
        devnum: Number(rf(`${root}/${e}/devnum`).trim()),
      });
    } catch { /* not a device dir / no idProduct */ }
  }
  found.sort((a, b) => a.busnum - b.busnum || comparePorts(a.port, b.port));
  return found.map((d, i) => ({ ...d, index: i }));
}

// "1-1.10" must sort after "1-1.2": compare port paths segment-by-segment
// numerically, the way the bus enumerates them.
function comparePorts(a: string, b: string): number {
  const as = a.split(/[-.]/).map(Number);
  const bs = b.split(/[-.]/).map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? -1) - (bs[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** The librtlsdr index for the dongle in a given port, right now. */
export function rtlIndexForPort(port: string, root = USB_ROOT): number | null {
  return listRtlDevices(root).find((d) => d.port === port)?.index ?? null;
}
