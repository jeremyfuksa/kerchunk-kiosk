// One sheet element for Library's sheets and detail. Phone (and every
// non-pane sheet): a modal <dialog> styled as a bottom sheet — native focus
// trap, Esc and inert page for free. Desktop detail (pane: true, ≥900px): the
// same <dialog> opened non-modally as a right-side pane, so the list beside it
// stays usable; Esc still closes it and focus returns to the opener.
import { esc } from "../../lib/format.js";
import { ico } from "./icons.js";

/** At or above this width a `pane` sheet opens beside the page, not over it. */
export const PANE_MIN_WIDTH_PX = 900;

export interface Sheet {
  readonly body: HTMLElement;
  open(o: { title: string; pane?: boolean }): void;
  close(): void;
  isOpen(): boolean;
  onClose(fn: () => void): void;
  setTitle(t: string): void;
}

export function mountSheet(host: HTMLElement, o: { id: string; label: string }): Sheet {
  host.insertAdjacentHTML("beforeend", `
    <dialog class="kc-sheet" id="${o.id}" aria-labelledby="${o.id}-title">
      <header class="kc-sheet__head">
        <h2 class="kc-sheet__title" id="${o.id}-title">${esc(o.label)}</h2>
        <button type="button" class="kc-sheet__close" aria-label="Close">${ico("close")}</button>
      </header>
      <div class="kc-sheet__body"></div>
    </dialog>`);
  const dlg = host.querySelector<HTMLDialogElement>(`#${o.id}`)!;
  const body = dlg.querySelector<HTMLElement>(".kc-sheet__body")!;
  const title = dlg.querySelector<HTMLElement>(".kc-sheet__title")!;
  const closeSubs: Array<() => void> = [];
  let opener: HTMLElement | null = null;

  dlg.querySelector(".kc-sheet__close")!.addEventListener("click", () => dlg.close());
  // A click on the modal backdrop lands on the <dialog> itself.
  dlg.addEventListener("click", (ev) => { if (ev.target === dlg && !dlg.classList.contains("kc-sheet--pane")) dlg.close(); });
  // A non-modal dialog gets no Esc handling from the browser.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && dlg.open && dlg.classList.contains("kc-sheet--pane")) dlg.close();
  });
  dlg.addEventListener("close", () => {
    document.documentElement.classList.remove(`${o.id}-pane-open`);
    opener?.focus();
    opener = null;
    for (const fn of closeSubs) fn();
  });

  return {
    body,
    open({ title: t, pane }) {
      title.textContent = t;
      if (dlg.open) return; // re-open = retitle only (the caller re-renders body)
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const asPane = !!pane && window.matchMedia(`(min-width: ${PANE_MIN_WIDTH_PX}px)`).matches;
      dlg.classList.toggle("kc-sheet--pane", asPane);
      document.documentElement.classList.toggle(`${o.id}-pane-open`, asPane);
      if (asPane) dlg.show(); else dlg.showModal();
      dlg.querySelector<HTMLElement>(".kc-sheet__close")!.focus();
    },
    close() { if (dlg.open) dlg.close(); },
    isOpen: () => dlg.open,
    onClose(fn) { closeSubs.push(fn); },
    setTitle(t) { title.textContent = t; },
  };
}
