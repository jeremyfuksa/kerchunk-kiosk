// Maps a weather-alert label (the SAME event name, e.g. "TORNADO WARNING", or a
// flagged channel's alphaTag) to a presentation theme: how URGENT it looks
// (tier → size/intensity) and which STORM it is (kind → color + icon). The
// palette itself lives in dashboard.css keyed off `.alertBar.<tier>[data-kind]`;
// this module only classifies, so colors stay tunable without touching logic.
import icoTornado from "lucide-static/icons/tornado.svg?raw";
import icoLightning from "lucide-static/icons/cloud-lightning.svg?raw";
import icoWaves from "lucide-static/icons/waves.svg?raw";
import icoSnow from "lucide-static/icons/snowflake.svg?raw";
import icoWind from "lucide-static/icons/wind.svg?raw";
import icoFlame from "lucide-static/icons/flame.svg?raw";
import icoSiren from "lucide-static/icons/siren.svg?raw";
import icoTest from "lucide-static/icons/triangle-alert.svg?raw";

export type AlertTier = "warning" | "watch" | "statement";
export type AlertKind =
  | "tornado" | "severe" | "flood" | "winter" | "wind"
  | "tropical" | "fire" | "civil" | "test" | "default";

export interface AlertTheme {
  /** Drives size + intensity: warning = loud solid fill, watch = framed, statement = subdued. */
  tier: AlertTier;
  /** Drives color + icon; CSS keys palette off `data-kind`. */
  kind: AlertKind;
  /** Inline SVG glyph for this storm type. */
  icon: string;
}

const KIND_ICON: Record<AlertKind, string> = {
  tornado: icoTornado, severe: icoLightning, flood: icoWaves, winter: icoSnow,
  wind: icoWind, tropical: icoWind, fire: icoFlame, civil: icoSiren,
  test: icoTest, default: icoSiren,
};

// First keyword hit wins, so order from most specific to least. WINTER never
// matches "WIND" (no D), so wind can safely follow winter.
function classifyKind(name: string): AlertKind {
  if (name.includes("WEEKLY") || name.includes("MONTHLY")
    || name.includes("PERIODIC") || name.includes("DEMO")
    || name.includes("PRACTICE")) return "test";
  if (name.includes("TORNADO")) return "tornado";
  if (name.includes("SEVERE")) return "severe";
  if (name.includes("FLOOD")) return "flood";
  if (name.includes("WINTER") || name.includes("BLIZZARD") || name.includes("ICE")) return "winter";
  if (name.includes("HURRICANE") || name.includes("TROPICAL")) return "tropical";
  if (name.includes("WIND") || name.includes("DUST")) return "wind";
  if (name.includes("FIRE")) return "fire";
  if (name.includes("CIVIL") || name.includes("DANGER") || name.includes("EVACU")
    || name.includes("SHELTER") || name.includes("HAZARD") || name.includes("NUCLEAR")
    || name.includes("RADIOLOG") || name.includes("EARTHQUAKE") || name.includes("VOLCANO")
    || name.includes("ABDUCTION") || name.includes("LAW ENFORCEMENT")
    || name.includes("EMERGENCY")) return "civil";
  return "default";
}

export function alertTheme(alphaTag: string): AlertTheme {
  const name = alphaTag.toUpperCase();
  const kind = classifyKind(name);
  // Tests never look like a live warning; otherwise the event word sets urgency.
  const tier: AlertTier =
    kind === "test" ? "statement"
    : name.includes("WATCH") ? "watch"
    : name.includes("STATEMENT") ? "statement"
    : "warning";
  return { tier, kind, icon: KIND_ICON[kind] };
}
