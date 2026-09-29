// What every admin-next tab is mounted with. Its own module so tabs don't
// import the entry point (index.ts) that imports them.
import type { Shell } from "./shell.js";
import type { LiveStore } from "./liveStore.js";
import type { Poller } from "./poller.js";
import type { Dialogs } from "./dialogs.js";

export interface Ctx { shell: Shell; live: LiveStore; poller: Poller; dialogs: Dialogs }
