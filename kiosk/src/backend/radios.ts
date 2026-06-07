import { readFileSync, readdirSync } from "node:fs";

// Multi-SDR device addressing (ROADMAP Idea 10, day 1).
//
// These RTL clones ignore EEPROM serial strings (writes persist, firmware
// serves the default 00000001 — verified 2026-06-06), so serial addressing
// is dead on this hardware. The USB PORT PATH is the identity instead:
// "1-1.2" is a physical jack on the hub, and whatever dongle sits in it
// owns that role. More honest for an appliance anyway — roles live on
// labeled ports, not on which dongle is which.
//
// librtlsdr exposes devices by INDEX in libusb enumeration order, which on
// Linux follows (busnum, devnum) ascending. devnums change on every
// replug, so the port -> index mapping is resolved fresh at every helper
// spawn, never cached.

const RTL_PRODUCT = "2838";
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
      if (rf(`${root}/${e}/idProduct`).trim() !== RTL_PRODUCT) continue;
      found.push({
        port: e,
        busnum: Number(rf(`${root}/${e}/busnum`).trim()),
        devnum: Number(rf(`${root}/${e}/devnum`).trim()),
      });
    } catch { /* not a device dir / no idProduct */ }
  }
  found.sort((a, b) => a.busnum - b.busnum || a.devnum - b.devnum);
  return found.map((d, i) => ({ ...d, index: i }));
}

/** The librtlsdr index for the dongle in a given port, right now. */
export function rtlIndexForPort(port: string, root = USB_ROOT): number | null {
  return listRtlDevices(root).find((d) => d.port === port)?.index ?? null;
}
