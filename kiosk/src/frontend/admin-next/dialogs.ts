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
  const toastHome = toastHost.parentElement!;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A showModal() dialog (a Library sheet, the confirm dialog itself, …) puts
  // the rest of the page — including this toast host, mounted once at the app
  // root — behind an inert barrier: Undo becomes unreachable while a sheet is
  // open. Before showing a toast, move the host inside the top-most OPEN
  // modal (skipping the confirm dialog, which must never host it) so it
  // renders in that dialog's top layer and stays interactive; with no modal
  // open, move it back home. `position: fixed` inside a dialog still tracks
  // the viewport (nothing here sets transform/filter/perspective), so the
  // toast's on-screen position is unchanged either way.
  function placeToastHost(): void {
    const modals = document.querySelectorAll<HTMLDialogElement>("dialog:modal");
    let top: HTMLDialogElement | null = null;
    for (const m of modals) if (m !== dlg) top = m;
    const target = top ?? toastHome;
    if (toastHost.parentElement === target) return;
    target.appendChild(toastHost);
    // A closed <dialog> goes `display: none` (it stays in the DOM), which
    // would hide a still-live toast — and its pending Undo — along with it.
    // Re-run this the moment ITS host closes, carrying the same live node
    // (and whatever timer/undo closure is still attached to it) to wherever
    // is now appropriate: the next still-open modal, or back home.
    if (target !== toastHome) target.addEventListener("close", placeToastHost, { once: true });
  }

  function close(): void {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    toastHost.innerHTML = "";
  }

  // A local function, not a method: callers pass `dialogs.toast` around bare,
  // and the undo path calls it again — no `this` to lose.
  const toast: Dialogs["toast"] = (text, o = {}) => {
    close();
    placeToastHost();
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
        try { await undo(); close(); toast("Undone."); }
        catch (e) {
          b.disabled = false; b.textContent = "Undo";
          const line = toastHost.querySelector<HTMLElement>(".kc-toast__text");
          if (line) line.textContent = (e as Error).message;
          timer = setTimeout(close, o.ms ?? TOAST_MS);
        }
      });
    }
    timer = setTimeout(close, o.ms ?? TOAST_MS);
  };

  return {
    toast,
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
