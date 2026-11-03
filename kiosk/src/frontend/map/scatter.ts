// Invented metro spots (spec 2026-10-13 silent chatter): a SILENT transmission
// with no honest location lands at a stable made-up point inside the kiosk's
// padded stage, with a stable colour — both pure functions of its frequency,
// so nothing is stored and repeat traffic builds one recognisable place.
// Area-uniform in the stage rect; the camera never moves, so stable on the wall.
import type { LatLngBox, Rect } from "./stage.js";
import { oklchHex } from "../lib/oklch.js";
import { familyFor } from "../../backend/config/family.js";

export interface ScatterStage { box: LatLngBox; width: number; height: number; inner: Rect }

export const SCATTER_KEY = (freqHz: number): string => `scatter:${freqHz}`;

// Glow band of the site palette (FAMILY_OKLCH spans L 0.62–0.84).
const SCATTER_L = 0.74, SCATTER_C = 0.17;

/** FNV-1a over the frequency's decimal digits + a salt → 0..1. */
function u01(freqHz: number, salt: string): number {
  const s = `${salt}:${freqHz}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const mercY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y: number): number => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

export function scatterSpot(freqHz: number, stage: ScatterStage, marginPx: number): { lat: number; lng: number; hex: string } {
  const { box, width, height, inner } = stage;
  const cx = (inner.left + inner.right) / 2, cy = (inner.top + inner.bottom) / 2;
  const halfW = Math.max(0, (inner.right - inner.left) / 2 - marginPx);
  const halfH = Math.max(0, (inner.bottom - inner.top) / 2 - marginPx);
  const x = cx + (u01(freqHz, "x") * 2 - 1) * halfW;
  const y = cy + (u01(freqHz, "y") * 2 - 1) * halfH;
  const lng = box.w + (x / width) * (box.e - box.w);
  const lat = invMercY(mercY(box.n) - (y / height) * (mercY(box.n) - mercY(box.s)));
  const hex = oklchHex({ L: SCATTER_L, C: SCATTER_C, h: u01(freqHz, "hue") * 360 });
  return { lat, lng, hex };
}

/** Silent by the speaker rule (spec 2026-10-13): a live event carries the
 *  engine-resolved channel.audible; a history row has none, so the family
 *  rule decides (a per-channel mute isn't visible there — acceptable). */
export function isSilentHit(
  freqHz: number, tags: readonly string[] | undefined,
  channelAudible: boolean | undefined, audibleFamilies: readonly string[],
): boolean {
  // CB-mode hits (tag "cb") stay off the map entirely — never scattered.
  if (tags?.includes("cb")) return false;
  if (channelAudible !== undefined) return !channelAudible;
  const fam = familyFor(freqHz, tags);
  return fam !== "weather" && !audibleFamilies.includes(fam);
}
