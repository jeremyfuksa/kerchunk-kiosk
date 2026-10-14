// CB mode (spec: in-chat design 2026-10-14): the 40 FCC Citizens Band
// channels, AM. They are never configured channels — CB is mostly silent, so
// it stays out of the scan rotation and off the map; the operator switches the
// whole scanner to CB-only listening instead. config.cb.channels narrows the
// set by channel number.
import type { Channel } from "./schema.js";

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

/** Default set: as many channels as one helper window holds (the grouping cap
 *  is the lane count — the whole band fits one 2 MHz window, so only the count
 *  matters), so CB mode never hops. CB_CORE first, then the rest counting up
 *  from 1; 36–40 (mostly SSB, which no lane demodulates) are the first cut. */
export function cbDefaultChannels(lanesPerGroup: number): number[] {
  const order = [...CB_CORE, ...CB_ALL.filter((n) => !(CB_CORE as readonly number[]).includes(n))];
  return order.slice(0, Math.max(1, lanesPerGroup)).sort((a, b) => a - b);
}

/** The CB-mode channel set. Always audible: picking CB mode is deliberate
 *  listening, so the family speaker gate doesn't apply. No location — CB
 *  hits land in history but never on the map. */
export function cbChannels(numbers: readonly number[] = CB_ALL): Channel[] {
  const out: Channel[] = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const freq = CB_FREQ_HZ[n];
    if (freq === undefined) continue;
    out.push({ id: `cb_${n}`, freq, alphaTag: `CB ${n}`, mode: "am", enabled: true, audible: true, tags: ["cb"] });
  }
  return out;
}
