// The CB wall's only moving layer: rings leaving the live mast, then holding still while it plays.
const NS = "http://www.w3.org/2000/svg";
const RINGS: ReadonlyArray<{ r: number; width: number; opacity: number }> = [
  { r: 34, width: 2.6, opacity: 0.85 }, { r: 64, width: 1.9, opacity: 0.59 }, { r: 98, width: 1.2, opacity: 0.33 },
];

export class CbRings {
  private anims: Animation[] = [];
  private fading = false;

  constructor(private readonly svg: SVGSVGElement, private readonly opts: () => { hitGrowMs: number; hitFadeMs: number }) {}

  clear(): void {
    for (const a of this.anims) a.cancel();
    this.anims = [];
    this.fading = false;
    this.svg.replaceChildren();
  }

  /** As it sits while playing, with no motion. */
  hold(x: number, y: number): SVGElement[] {
    this.clear();
    return RINGS.map((ring) => {
      const el = document.createElementNS(NS, "circle");
      for (const [k, v] of Object.entries({ cx: x, cy: y, r: ring.r, "stroke-width": ring.width, opacity: ring.opacity })) el.setAttribute(k, String(v));
      this.svg.appendChild(el);
      return el;
    });
  }

  start(x: number, y: number): void {
    const els = this.hold(x, y);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const { hitGrowMs } = this.opts();
    const anims = els.map((el, i) => el.animate(
      [{ r: "0px", opacity: 0.9 }, { r: `${RINGS[i]!.r}px`, opacity: RINGS[i]!.opacity }],
      { duration: hitGrowMs, delay: i * (hitGrowMs / 4), easing: "cubic-bezier(.33,1,.68,1)", fill: "backwards" },
    ));
    this.anims = anims;
    // Cancelled once finished, so nothing is left running. Cancelling leaves the held state.
    void Promise.allSettled(anims.map((a) => a.finished)).then(() => { if (this.anims === anims) this.anims = []; });
  }

  end(): void {
    if (this.fading || !this.svg.firstChild) return;
    for (const a of this.anims) a.cancel();
    const anims = Array.from(this.svg.children).map((el) => el.animate([{ opacity: el.getAttribute("opacity") }, { opacity: 0 }], { duration: this.opts().hitFadeMs, easing: "ease-out", fill: "forwards" }));
    this.anims = anims;
    this.fading = true;
    void Promise.allSettled(anims.map((a) => a.finished)).then(() => { if (this.anims === anims) this.clear(); });
  }
}
