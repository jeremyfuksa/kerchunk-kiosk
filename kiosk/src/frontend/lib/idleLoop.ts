// Shared idle-suspend animation loop, factored from map.ts's proven pattern.
// A continuous requestAnimationFrame is a thermal regression on the 24/7 2014
// appliance: this loop STOPS scheduling entirely when nothing animates (tick
// returns false) and resumes only on wake(). The default scheduler dual-arms
// (rAF for smoothness + a wall-clock fallback) so a dropped/deferred rAF can
// never strand the loop. The scheduler is injectable for headless tests.

export interface IdleLoopOptions {
  /** Paint one frame. Return true if more frames are needed (something is still
   *  animating), false if the view is now static and the loop may suspend. */
  tick: () => boolean;
  /** Schedule the next frame. Defaults to rAF + 250ms wall-clock fallback. */
  schedule?: (cb: () => void) => void;
}

export interface IdleLoop {
  /** Start (or resume) the loop if it isn't already running and wasn't stopped. */
  wake(): void;
  /** True while the loop is scheduling frames. */
  readonly running: boolean;
  /** Permanently stop the loop (teardown on unmount). */
  stop(): void;
}

function defaultSchedule(cb: () => void): void {
  // rAF gives smooth motion, but is NEVER the sole re-arm: if the compositor
  // defers/drops it (deep idle), the wall-clock fallback still fires. `ran`
  // guards against the two paths double-firing.
  let ran = false;
  const go = (): void => { if (ran) return; ran = true; cb(); };
  requestAnimationFrame(() => setTimeout(go, 40));
  setTimeout(go, 250);
}

export function createIdleLoop(opts: IdleLoopOptions): IdleLoop {
  const schedule = opts.schedule ?? defaultSchedule;
  let running = false;
  let stopped = false;

  function frame(): void {
    if (stopped) { running = false; return; }
    const cont = opts.tick();
    if (cont && !stopped) schedule(frame);
    else running = false;
  }

  return {
    wake(): void {
      if (running || stopped) return;
      running = true;
      schedule(frame);
    },
    get running(): boolean { return running; },
    stop(): void { stopped = true; running = false; },
  };
}
