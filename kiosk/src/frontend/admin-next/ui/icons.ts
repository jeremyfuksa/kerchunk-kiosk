// Every glyph in admin-next comes from lucide-static (operator mandate).
import radio from "lucide-static/icons/radio.svg?raw";
import tune from "lucide-static/icons/sliders-horizontal.svg?raw";
import library from "lucide-static/icons/library.svg?raw";
import system from "lucide-static/icons/cpu.svg?raw";
import play from "lucide-static/icons/play.svg?raw";
import stop from "lucide-static/icons/square.svg?raw";
import skip from "lucide-static/icons/skip-forward.svg?raw";
import weather from "lucide-static/icons/cloud-lightning.svg?raw";
import pause from "lucide-static/icons/timer.svg?raw";
import lockout from "lucide-static/icons/ban.svg?raw";
import volume from "lucide-static/icons/volume-2.svg?raw";
import volumeOff from "lucide-static/icons/volume-x.svg?raw";
import close from "lucide-static/icons/x.svg?raw";
import external from "lucide-static/icons/arrow-up-right.svg?raw";
import chevron from "lucide-static/icons/chevron-right.svg?raw";
import trash from "lucide-static/icons/trash-2.svg?raw";
import plus from "lucide-static/icons/plus.svg?raw";
import check from "lucide-static/icons/check.svg?raw";
// speaker reuses volume-2; speakerOff reuses volume-x
const ICONS = { radio, tune, library, system, play, stop, skip, weather, pause, lockout, volume, volumeOff, close, external, chevron, trash, plus, check, speaker: volume, speakerOff: volumeOff } as const;
export type IconName = keyof typeof ICONS;

export function ico(name: IconName, cls = "kc-ico"): string {
  return ICONS[name].replace("<svg", `<svg class="${cls}" aria-hidden="true" focusable="false"`);
}
