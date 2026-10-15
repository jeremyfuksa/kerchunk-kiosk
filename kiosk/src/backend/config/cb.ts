// CB mode (spec: in-chat design 2026-10-14): the 40 FCC Citizens Band
// channels, AM. They are never configured channels — CB is mostly silent, so
// it stays out of the scan rotation and off the map; the operator switches the
// whole scanner to CB-only listening instead. config.cb.channels narrows the
// set by channel number; config.cb.modes makes a channel LSB (38 by default,
// spec 2026-10-15).
import type { ScanChannel } from "../engine/ScannerEngine.js";

// Channel number → Hz. Not monotonic: 23 sits above 24 and 25 (historic
// allocation), and 3→4, 7→8, 11→12, 15→16, 19→20 skip a 10 kHz slot.
export const CB_FREQ_HZ: Readonly<Record<number, number>> = {
  1: 26_965_000, 2: 26_975_000, 3: 26_985_000, 4: 27_005_000, 5: 27_015_000,
  6: 27_025_000, 7: 27_035_000, 8: 27_055_000, 9: 27_065_000, 10: 27_075_000,
  11: 27_085_000, 12: 27_105_000, 13: 27_115_000, 14: 27_125_000, 15: 27_135_000,
  16: 27_155_000, 17: 27_165_000, 18: 27_175_000, 19: 27_185_000, 20: 27_205_000,
  21: 27_215_000, 22: 27_225_000, 23: 27_255_000, 24: 27_235_000, 25: 27_245_000,
  26: 27_265_000, 27: 27_275_000, 28: 27_285_000, 29: 27_295_000, 30: 27_305_000,
  31: 27_315_000, 32: 27_325_000, 33: 27_335_000, 34: 27_345_000, 35: 27_355_000,
  36: 27_365_000, 37: 27_375_000, 38: 27_385_000, 39: 27_395_000, 40: 27_405_000,
};

export const CB_ALL = Array.from({ length: 40 }, (_, i) => i + 1);

/** The channels the operator actually listens for (9 = emergency, 19 =
 *  highway). Always in the default set. */
export const CB_CORE = [6, 9, 19] as const;

export type CbMode = "am" | "lsb";

/** 38 LSB is the US SSB calling channel (operator, 2026-10-15). config.cb.modes
 *  replaces the whole map. */
export const CB_MODES_DEFAULT: Readonly<Record<string, CbMode>> = { "38": "lsb" };

/** SSB speech pauses between syllables; a short hang chops it. */
export const CB_SSB_HANG_MS = 1500;

/** config.cb satisfies this structurally. */
export interface CbChannelOpts {
  modes?: Readonly<Record<string, CbMode>>;
  ssbOpenDb?: number;
  ssbHangMs?: number;
}

/** Default set: as many channels as one helper window holds (the grouping cap
 *  is the lane count — the whole band fits one 2 MHz window, so only the count
 *  matters), so CB mode never hops. CB_CORE and every non-AM channel in `modes`
 *  first (the LSB channels are why the operator turned the mode on), then the
 *  rest counting up from 1; the top of the band is the first cut. */
export function cbDefaultChannels(lanesPerGroup: number, modes: Readonly<Record<string, CbMode>> = CB_MODES_DEFAULT): number[] {
  const always = [...new Set([...CB_CORE, ...Object.keys(modes).filter((k) => modes[k] !== "am").map(Number)])];
  const order = [...always, ...CB_ALL.filter((n) => !always.includes(n))];
  return order.slice(0, Math.max(1, lanesPerGroup)).sort((a, b) => a - b);
}

/** Built-in channel names (operator: 6 "Super Bowl", 9 "Emergency",
 *  19 "Highway"). config.cb.names replaces the whole map. */
export const CB_NAMES_DEFAULT: Readonly<Record<string, string>> = { "6": "Super Bowl", "9": "Emergency", "19": "Highway" };

/** The CB channel number at exactly this frequency, or null (history rows
 *  carry only freq). */
export function cbNumberForFreq(freqHz: number): number | null {
  for (const n of CB_ALL) if (CB_FREQ_HZ[n] === freqHz) return n;
  return null;
}

/** "CB 19 · Highway", or "CB 14" for an unnamed channel. */
export function cbLabel(n: number, names: Readonly<Record<string, string>> = CB_NAMES_DEFAULT): string {
  const name = names[String(n)];
  return name ? `CB ${n} · ${name}` : `CB ${n}`;
}

/** The CB-mode channel set: AM, or the mode from `opts.modes`. Always
 *  audible: picking CB mode is deliberate listening, so the family speaker gate
 *  doesn't apply. No location — CB hits land in history but never on the map.
 *  LSB channels carry the SSB squelch (hang, optional open threshold). */
export function cbChannels(
  numbers: readonly number[] = CB_ALL,
  names: Readonly<Record<string, string>> = CB_NAMES_DEFAULT,
  opts: CbChannelOpts = {},
): ScanChannel[] {
  const modes = opts.modes ?? CB_MODES_DEFAULT;
  const out: ScanChannel[] = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const freq = CB_FREQ_HZ[n];
    if (freq === undefined) continue;
    const mode = modes[String(n)] ?? "am";
    out.push({
      id: `cb_${n}`, freq, alphaTag: cbLabel(n, names), mode, enabled: true, audible: true, tags: ["cb"],
      ...(mode === "lsb" ? {
        hangMs: opts.ssbHangMs ?? CB_SSB_HANG_MS,
        ...(opts.ssbOpenDb !== undefined ? { openAboveFloorDb: opts.ssbOpenDb } : {}),
      } : {}),
    });
  }
  return out;
}
