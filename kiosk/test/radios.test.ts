import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listRtlDevices } from "../src/backend/radios.js";

function fakeUsbTree(): string {
  const root = mkdtempSync(join(tmpdir(), "usb-"));
  const mk = (port: string, product: string, busnum: number, devnum: number) => {
    mkdirSync(join(root, port));
    writeFileSync(join(root, port, "idProduct"), product + "\n");
    writeFileSync(join(root, port, "busnum"), String(busnum) + "\n");
    writeFileSync(join(root, port, "devnum"), String(devnum) + "\n");
  };
  // devnums deliberately CONTRADICT port order (a port power-cycle gives
  // one dongle a fresh high devnum): topology must win, devnum must lose.
  mk("1-1.4", "2838", 1, 22);
  mk("1-1.2", "2838", 1, 23);   // re-cycled: newest devnum, FIRST port
  mk("1-1.3", "2838", 1, 21);
  mk("1-1.10", "2838", 1, 24);  // natural compare: .10 sorts after .4
  mk("1-2", "011e", 1, 3);      // the wifi dongle: not an RTL
  return root;
}

describe("RTL device addressing by USB port", () => {
  it("orders by USB topology (port order), never devnum — librtlsdr's real order", () => {
    const devs = listRtlDevices(fakeUsbTree());
    expect(devs.map((d) => [d.port, d.index])).toEqual([
      ["1-1.2", 0], ["1-1.3", 1], ["1-1.4", 2], ["1-1.10", 3],
    ]);
  });
  it("ignores non-RTL devices and missing roots", () => {
    expect(listRtlDevices("/nonexistent")).toEqual([]);
    expect(listRtlDevices(fakeUsbTree()).some((d) => d.port === "1-2")).toBe(false);
  });
});
