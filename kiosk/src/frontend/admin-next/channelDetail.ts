// Library · channel detail (sheet below 900px, right pane above). Stub for
// PR 4 Task 4; Task 5 replaces it with the real detail.
import type { Detail } from "./route.js";
import type { LibCtx } from "./libraryStore.js";

export function mountDetail(_lib: LibCtx, _host: HTMLElement): {
  show(d: Detail, o: { fromList: boolean }): void; hide(): void; paint(): void; isOpen(): boolean;
} {
  return { show() {}, hide() {}, paint() {}, isOpen: () => false };
}
