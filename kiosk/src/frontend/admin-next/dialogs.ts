// Toast (with undo) and confirm, ported from the classic admin's
// acknowledgement layer: keep the toast mounted until an undo settles, so a
// rejected undo (409) keeps its retry affordance.
import { esc } from "../lib/format.js";
import { ico } from "./ui/icons.js";

/** How long a toast (and its undo) stays offered. */
export const TOAST_MS = 8000;

export interface Dialogs {
  toast(text: string, o?: { undo?: () => Promise<void>; ms?: number }): void;
  confirm(o: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
}

export function mountDialogs(host: HTMLElement): Dialogs {
  host.insertAdjacentHTML("beforeend", `
    <div class="kc-toastHost" role="status" aria-live="polite"></div>
    <dialog class="kc-confirm" aria-labelledby="kcConfirmTitle" aria-describedby="kcConfirmMsg">
      <form method="dialog">
        <h2 id="kcConfirmTitle"></h2>
        <p id="kcConfirmMsg"></p>
        <div class="kc-confirm__actions">
          <button class="kc-key" value="cancel">Cancel</button>
          <button class="kc-key" id="kcConfirmGo" value="confirm"></button>
        </div>
      </form>
    </dialog>`);
  const toastHost = host.querySelector<HTMLElement>(".kc-toastHost")!;
  const dlg = host.querySelector<HTMLDialogElement>(".kc-confirm")!;
  const go = dlg.querySelector<HTMLButtonElement>("#kcConfirmGo")!;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(): void {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    toastHost.innerHTML = "";
  }

  return {
    toast(text, o = {}) {
      close();
      toastHost.innerHTML = `<div class="kc-toast"><span class="kc-toast__text">${esc(text)}</span>${
        o.undo ? `<button type="button" class="kc-toast__undo">Undo</button>` : ""
      }<button type="button" class="kc-toast__close" aria-label="Dismiss">${ico("close")}</button></div>`;
      toastHost.querySelector(".kc-toast__close")!.addEventListener("click", close);
      const undo = o.undo;
      if (undo) {
        const b = toastHost.querySelector<HTMLButtonElement>(".kc-toast__undo")!;
        b.addEventListener("click", async () => {
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          b.disabled = true; b.textContent = "Undoing…";
          try { await undo(); close(); this.toast("Undone."); }
          catch (e) {
            b.disabled = false; b.textContent = "Undo";
            const line = toastHost.querySelector<HTMLElement>(".kc-toast__text");
            if (line) line.textContent = (e as Error).message;
            timer = setTimeout(close, o.ms ?? TOAST_MS);
          }
        });
      }
      timer = setTimeout(close, o.ms ?? TOAST_MS);
    },
    confirm(o) {
      // A double-fired destructive action (e.g. a double-tapped "Lock out")
      // must not throw (showModal() on an already-open <dialog> raises
      // InvalidStateError) or stack a second confirm on top of the first.
      if (dlg.open) return Promise.resolve(false);
      dlg.querySelector("#kcConfirmTitle")!.textContent = o.title;
      dlg.querySelector("#kcConfirmMsg")!.textContent = o.message;
      go.textContent = o.confirmLabel;
      go.className = `kc-key ${o.danger ? "kc-key--danger" : "kc-key--primary"}`;
      dlg.returnValue = "cancel";
      dlg.showModal();
      return new Promise((resolve) => {
        dlg.addEventListener("close", () => resolve(dlg.returnValue === "confirm"), { once: true });
      });
    },
  };
}
