// CB mode: the 40 FCC Citizens Band channels, heard through the FernSDR
// network receiver (spec 2026-10-15-cb-fernsdr). They are never configured
// channels — CB is mostly silent, so it stays out of the scan rotation and off
// the map; the operator switches the whole scanner to CB-only listening
// instead. config.cb.channels narrows the set by channel number;
// config.cb.modes makes a channel LSB (38 by default).
import type { ScanChannel } from "../engine/ScannerEngine.js";
import type { Config } from "./schema.js";

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

/** Channels that pre-empt the audible one (operator: 6/9/19 matter most). */
export const CB_PRIORITY_DEFAULT = [6, 9, 19] as const;

/** config.cb.fernsdr defaults (spec 2026-10-15-cb-fernsdr). */
export const CB_FERNSDR_DEFAULTS = {
  url: "ws://192.168.1.30:8073/ws",
  band: "cb-radio",
  openDb: 10,
  openRows: 2,
  hangMs: 2000,
  maxOpenMs: 180_000,
  bufferMs: 120,
  maxBufferMs: 400,
  backoffMaxMs: 60_000,
  staleMs: 8000,
  audioTailMs: 300,
} as const;

/** The CB channel set as events carry it: `cb_N` ids, labels, AM or the
 *  mode from `modes`. Always audible — picking CB mode is deliberate
 *  listening. No location: CB lands in history, never on the map. */
export function cbChannels(
  numbers: readonly number[] = CB_ALL,
  names: Readonly<Record<string, string>> = CB_NAMES_DEFAULT,
  modes: Readonly<Record<string, CbMode>> = CB_MODES_DEFAULT,
): ScanChannel[] {
  const out: ScanChannel[] = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const freq = CB_FREQ_HZ[n];
    if (freq === undefined) continue;
    out.push({ id: `cb_${n}`, freq, alphaTag: cbLabel(n, names), mode: modes[String(n)] ?? "am", enabled: true, audible: true, tags: ["cb"] });
  }
  return out;
}

export interface CbNetConfig {
  url: string;
  band: string;
  channels: ScanChannel[];
  priority: number[];
  openDb: number;
  openRows: number;
  hangMs: number;
  ssbHangMs: number;
  maxOpenMs: number;
  backoffMaxMs: number;
  staleMs: number;
  audioTailMs: number;
}

/** Everything CbNet needs, resolved from config.cb with defaults. */
export function cbNetConfig(cfg: Pick<Config, "cb">): CbNetConfig {
  const cb = cfg.cb;
  const f = { ...CB_FERNSDR_DEFAULTS, ...(cb?.fernsdr ?? {}) };
  return {
    url: f.url, band: f.band,
    channels: cbChannels(cb?.channels ?? CB_ALL, cb?.names, cb?.modes),
    priority: [...(cb?.priority ?? CB_PRIORITY_DEFAULT)],
    openDb: f.openDb, openRows: f.openRows, hangMs: f.hangMs,
    ssbHangMs: cb?.ssbHangMs ?? CB_SSB_HANG_MS,
    maxOpenMs: f.maxOpenMs, backoffMaxMs: f.backoffMaxMs,
    staleMs: f.staleMs, audioTailMs: f.audioTailMs,
  };
}
