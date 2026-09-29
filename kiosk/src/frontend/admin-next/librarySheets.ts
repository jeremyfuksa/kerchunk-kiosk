// Library · Manage banks and Suggestions sheets. Stub for PR 4 Task 4;
// Task 6 replaces it with the real sheets.
import type { LibCtx } from "./libraryStore.js";

export function mountSheets(_lib: LibCtx, _host: HTMLElement): { openBanks(): void; openSuggestions(): void } {
  return { openBanks() {}, openSuggestions() {} };
}
