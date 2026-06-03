// kiosk/src/backend/config/schema.ts
import { z } from "zod";

export const channelSchema = z.object({
  id: z.string().min(1),
  freq: z.number().int().positive(),
  alphaTag: z.string(),
  mode: z.enum(["fm", "nfm", "am"]),
  enabled: z.boolean(),
});

export const configSchema = z.object({
  version: z.literal(1),
  scan: z.object({
    sampleRate: z.number().int().positive(),
    squelchLevel: z.number().int().nonnegative(),
    gain: z.union([z.number(), z.literal("auto")]),
    dwellMs: z.number().int().positive(),
  }),
  audio: z.object({
    sink: z.string().min(1),
    volume: z.number().int().min(0).max(100),
    muted: z.boolean(),
  }),
  channels: z.array(channelSchema),
});

export type Channel = z.infer<typeof channelSchema>;
export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return {
    version: 1,
    scan: { sampleRate: 12000, squelchLevel: 150, gain: "auto", dwellMs: 2000 },
    audio: { sink: "hdmi:CARD=vc4hdmi0", volume: 70, muted: false },
    channels: [],
  };
}
