// kiosk/src/backend/config/schema.ts
import { z } from "zod";

export const channelSchema = z.object({
  id: z.string().min(1),
  freq: z.number().int().positive(),
  alphaTag: z.string(),
  mode: z.enum(["fm", "nfm", "am"]),
  enabled: z.boolean(),
  // Priority channels preempt the speaker from non-priority ones when both
  // are active in the same group (hardware-scanner "priority scan").
  priority: z.boolean().optional(),
});

export const configSchema = z.object({
  version: z.literal(1),
  scan: z.object({
    sampleRate: z.number().int().positive(),
    squelchLevel: z.number().int().nonnegative(),
    gain: z.union([z.number(), z.literal("auto")]),
    dwellMs: z.number().int().positive(),
    // Wideband engine tuning (optional; RtlFmEngine ignores these).
    // Usable I/Q window for grouping — keep under the dongle's ~2.4 MHz
    // instantaneous bandwidth to leave guard band.
    windowBandwidthHz: z.number().int().positive().optional(),
    // Dwell per group before hopping to the next (hold-through overrides).
    groupDwellMs: z.number().int().positive().optional(),
    // Squelch: open when channel power exceeds its learned noise floor by
    // this many dB (close threshold sits 3 dB lower for hysteresis).
    openAboveFloorDb: z.number().positive().optional(),
    // Quieting squelch: discriminator HF-noise level (dB) BELOW which a
    // channel counts as carrier-quieted. Power without quieting never opens
    // (rejects spurs/AGC pumping/broadband bursts — non-voice junk). Bench
    // default in the DSP helper: -86 (static ~-82, voice carrier -94..-96).
    noiseQuietDb: z.number().negative().optional(),
    // Close Call: discover strong transmissions in the tuned window on
    // non-configured frequencies. Plays them (priority preempt) and auto-adds
    // them as DISABLED channels for operator review. Default ON (wideband).
    closeCall: z.boolean().optional(),
    // Discovery threshold: dB over the window's median noise floor. Eager by
    // default (15) per operator preference.
    closeCallDb: z.number().positive().optional(),
    // Close Call lockouts: frequencies that must NEVER trigger discovery
    // again (noise sources, data links the operator dismissed).
    lockoutHz: z.array(z.number().int().positive()).optional(),
  }),
  audio: z.object({
    sink: z.string().min(1),
    volume: z.number().int().min(0).max(100),
    muted: z.boolean(),
    // ALSA mixer target for volume/mute. amixer addresses controls by card
    // INDEX or NAME + control NAME, which differ per device (e.g. HDMI exposes
    // no volume control; the Pi headphone jack is card 2 / "PCM"). Prefer the
    // NAME ("PCH"): card indices are assigned in probe order and can swap
    // across boots when multiple controllers race (bit the Ubuntu laptop on
    // its first appliance boot). Optional so existing configs default to
    // card 0 / "Master".
    mixerCard: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
    mixerControl: z.string().min(1).optional(),
  }),
  // RepeaterBook lookup (Close Call enrichment). userAgent must be the
  // string REGISTERED with RepeaterBook; states are full names ("Missouri").
  lookup: z.object({
    userAgent: z.string().min(1),
    states: z.array(z.string().min(1)).min(1),
    // RadioReference fallback (business band / public safety). Requires an
    // approved developer appKey + the OPERATOR'S premium credentials; all
    // stay in this config file on the appliance, never in the repo.
    radioReference: z.object({
      appKey: z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(1),
      countyIds: z.array(z.number().int().positive()).min(1),
    }).optional(),
  }).optional(),
  // One channel designated as "the weather channel", stored separately from the
  // scan list. Weather-only mode (server runtime) holds this channel.
  weatherChannel: channelSchema.optional(),
  channels: z.array(channelSchema),
});

export type Channel = z.infer<typeof channelSchema>;
export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return {
    version: 1,
    // squelchLevel is an RMS open-threshold. Bench-measured noise floor ~150,
    // noise spikes ~1436, real signal ~2900. 1800 clears the noise spikes with
    // margin while staying below signal, avoiding constant false squelch-opens.
    scan: { sampleRate: 12000, squelchLevel: 1800, gain: "auto", dwellMs: 2000 },
    audio: { sink: "hdmi:CARD=vc4hdmi0", volume: 70, muted: false },
    channels: [],
  };
}
