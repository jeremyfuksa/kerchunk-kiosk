// Weather Glass: one WebGLOverlayView drawing inside Google's own GL context
// (spec 2026-10-01 §1). Per frame: (1) the real-radar mesh, premultiplied;
// (2) an additive full-viewport pass with haze, afterglows and live fronts.
// Pins, aircraft and the edge glow stay Google/DOM objects above it.
//
// GL state discipline: Google owns this context. Every draw saves what it
// touches and restores it, and all texture uploads happen inside onDraw
// (never from a fetch callback), so we never fight the map renderer.
import { RADAR_VS, RADAR_FS, FX_VS, FX_FS, SMOKE_FS } from "./glassShaders.js";
import {
  MAX_FRONTS, MAX_PUFFS, STEP_WRAP, SmokeCache, mercatorOffsetM, clipToPx, paceDelay,
  type GlassFrame,
} from "./glassMath.js";
import type { RadarFrame } from "./radarSync.js";
import { RadarFade } from "./radarFade.js";

declare const google: any;

export interface GlassKnobs {
  maxFps: number; txFps: number; hazeIntensity: number; radarOpacity: number;
  radarMinDbz: number; radarFadeMs: number; txGrowMs: number;
  holdFps: number; signalSteps: number;
  smokeLifeMs: number; smokeStepMs: number; smokePxPerMph: number;
  smokeBody: number; sparkDensity: number; puffMergeMs: number; smokeScale: number;
}

export interface GlassLayerOptions {
  map: any;
  home: { lat: number; lng: number };
  knobs: GlassKnobs;
  getFrame: (now: number) => GlassFrame;
}

// Fallback: if Google drops a requested redraw, retry after this long.
const KICK_MS = 1000;
const MESH_DIV = 32; // mesh subdivisions per axis (equirect → Mercator)
const SMOKE_DOWNSCALE = 2; // smoke target is 1/2 the drawing buffer per axis

type Gl = WebGL2RenderingContext;
interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

export class GlassLayer {
  status = "pending";
  private readonly ov: any;
  private gl: Gl | null = null;
  private radarProg: Prog | null = null;
  private fxProg: Prog | null = null;
  private smokeProg: Prog | null = null;
  private smokeFbo: WebGLFramebuffer | null = null;
  private smokeTex: WebGLTexture | null = null;
  private smokeSize: [number, number] = [0, 0];
  private readonly smokeCache = new SmokeCache();
  private readonly smokeSig = new Float32Array(MAX_PUFFS * 12 + 4);
  private meshVao: WebGLVertexArrayObject | null = null;
  private meshCount = 0;
  private meshBounds: RadarFrame["meta"]["bounds"] | null = null;
  private fxVao: WebGLVertexArrayObject | null = null;
  private tex: [WebGLTexture | null, WebGLTexture | null] = [null, null];
  private nextIdx = 0;                     // tex[nextIdx] = newest scan
  private texSize: [number, number] = [1, 1];
  private pending: RadarFrame | null = null;
  private last: RadarFrame | null = null;  // re-upload after context loss
  private readonly fade: RadarFade;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly t0 = performance.now();
  private readonly fronts = new Float32Array(MAX_FRONTS * 4);
  private readonly frontsB = new Float32Array(MAX_FRONTS * 4);
  private readonly frontsC = new Float32Array(MAX_FRONTS * 3);
  private readonly puffsA = new Float32Array(MAX_PUFFS * 4);
  private readonly puffsB = new Float32Array(MAX_PUFFS * 4);
  private readonly puffsC = new Float32Array(MAX_PUFFS * 4);
  private lastFrame: GlassFrame | null = null;
  private redraws = 0;
  private smokeRenders = 0;
  private timerAt = 0; // Date.now() ms the armed timer fires

  /** True once the layer has given up (no WebGL2, shader failure): it is
   *  unmounted and draws nothing, so callers stop feeding it. */
  get off(): boolean { return this.status.startsWith("off"); }

  constructor(private readonly o: GlassLayerOptions) {
    this.fade = new RadarFade(o.knobs.radarFadeMs);
    this.ov = new google.maps.WebGLOverlayView();
    this.ov.onAdd = () => {};
    this.ov.onContextRestored = ({ gl }: { gl: WebGLRenderingContext | Gl }) => this.init(gl);
    this.ov.onContextLost = () => { this.gl = null; this.radarProg = this.fxProg = this.smokeProg = null; this.smokeFbo = null; this.smokeTex = null; this.smokeSize = [0, 0]; this.smokeCache.invalidate(); this.meshVao = this.fxVao = null; this.tex = [null, null]; this.meshBounds = null; this.fade.contextLost(); this.pending = this.last; };
    this.ov.onDraw = ({ gl, transformer }: { gl: Gl; transformer: any }) => this.draw(gl, transformer);
    this.ov.onRemove = () => {};
    this.ov.setMap(o.map);
    this.arm(KICK_MS);
  }

  setRadar(f: RadarFrame): void { this.pending = f; this.poke(); }

  setRadarStale(stale: boolean): void {
    this.fade.setStale(stale, performance.now());
    this.poke();
  }

  private giveUp(status: string): void {
    this.status = status;
    this.stop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ov.setMap(null);
  }

  // ── pacing (spec 2026-10-02): after every draw, the frame says when it will
  // next visibly change. Continuous (grow/dissolve/haze/radar fade) → fps
  // timer; a scheduled change → one timer to that moment; nothing → no timer.
  // Every armed timer re-arms a KICK_MS fallback, so a redraw Google drops
  // can't freeze a half-grown front.
  private arm(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.off) return;
      this.ov.requestRedraw();
      this.arm(KICK_MS);
    }, delayMs);
  }

  private reschedule(): void {
    if (this.off) return;
    const f = this.lastFrame;
    if (!f) { this.arm(KICK_MS); return; }
    const delay = paceDelay(f, Date.now(), {
      haze: this.o.knobs.hazeIntensity > 0,
      radarFading: this.fade.fading(performance.now()),
      maxFps: this.o.knobs.maxFps, txFps: this.o.knobs.txFps,
    });
    if (delay === null) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    } else this.arm(delay);
  }

  /** An event changed the scene (key-up, release, signal step, seed): draw now. */
  poke(): void {
    if (this.off) return;
    this.ov.requestRedraw();
    this.arm(KICK_MS);
  }

  /** A change is due at `at` (Date.now() ms) with no draw before it — e.g. a
   *  parked signal step (review I2). Never delays an earlier armed timer. */
  redrawAt(at: number): void {
    if (this.off) return;
    const now = Date.now();
    if (at <= now) { this.poke(); return; }
    if (this.timer && this.timerAt <= at) return;
    this.arm(at - now);
  }

  /** Redraws since the last call (diag: glass redraws per minute). */
  takeRedraws(): number {
    const n = this.redraws;
    this.redraws = 0;
    return n;
  }

  /** Smoke-pass renders since the last call (diag: should track smoke ticks,
   *  ~60 000 / smokeStepMs per minute, not the redraw rate). */
  takeSmokeRenders(): number {
    const n = this.smokeRenders;
    this.smokeRenders = 0;
    return n;
  }

  private init(raw: WebGLRenderingContext | Gl): void {
    if (typeof WebGL2RenderingContext === "undefined" || !(raw instanceof WebGL2RenderingContext)) {
      this.giveUp("off:no-webgl2");
      return;
    }
    const gl = raw;
    this.radarProg = link(gl, RADAR_VS, RADAR_FS, ["uMvp", "uPrev", "uNext", "uTexSize", "uMix", "uAlpha", "uMinDbz", "uOpacity"]);
    this.fxProg = link(gl, FX_VS, FX_FS, ["uRes", "uTime", "uHaze", "uFrontA", "uFrontB", "uFrontC", "uNFronts", "uSmoke", "uHasSmoke"]);
    this.smokeProg = link(gl, FX_VS, SMOKE_FS, ["uScale", "uPuffA", "uPuffB", "uPuffC", "uNPuffs", "uStep", "uSmokeBody", "uSparkDensity"]);
    if (!this.radarProg || !this.fxProg || !this.smokeProg) { this.giveUp("off:shader"); return; }
    const saved = saveGl(gl);
    this.fxVao = gl.createVertexArray();
    gl.bindVertexArray(this.fxVao);
    const fxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);   // aPos is layout(location = 0) in FX_VS (FX + SMOKE)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.tex[i] = t;
    }
    restoreGl(gl, saved);
    this.gl = gl;
    this.status = "on";
    if (this.last && !this.pending) this.pending = this.last;
  }

  private buildMesh(gl: Gl, b: RadarFrame["meta"]["bounds"]): void {
    const n = MESH_DIV + 1;
    const pos = new Float32Array(n * n * 2), uv = new Float32Array(n * n * 2);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const lat = b.n - ((b.n - b.s) * i) / MESH_DIV;
        const lng = b.w + ((b.e - b.w) * j) / MESH_DIV;
        const [x, y] = mercatorOffsetM(lat, lng, this.o.home);
        const k = (i * n + j) * 2;
        pos[k] = x; pos[k + 1] = y;
        uv[k] = j / MESH_DIV; uv[k + 1] = i / MESH_DIV; // v=0 = north row (first uploaded)
      }
    }
    const idx = new Uint16Array(MESH_DIV * MESH_DIV * 6);
    let p = 0;
    for (let i = 0; i < MESH_DIV; i++) for (let j = 0; j < MESH_DIV; j++) {
      const a = i * n + j, c = a + n;
      idx.set([a, c, a + 1, a + 1, c, c + 1], p); p += 6;
    }
    const prog = this.radarProg!.p;
    this.meshVao = gl.createVertexArray();
    gl.bindVertexArray(this.meshVao);
    const bind = (data: Float32Array, name: string): void => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const l = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
    };
    bind(pos, "aPos");
    bind(uv, "aUv");
    const ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.meshCount = idx.length;
    this.meshBounds = b;
  }

  private upload(gl: Gl, t: WebGLTexture | null, f: RadarFrame): void {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, f.meta.width, f.meta.height, 0, gl.RED, gl.UNSIGNED_BYTE, f.bytes);
  }

  private takePending(gl: Gl, now: number): void {
    const f = this.pending;
    if (!f) return;
    this.pending = null;
    this.last = f;
    const b = f.meta.bounds, mb = this.meshBounds;
    const sameBounds = !!mb && mb.n === b.n && mb.s === b.s && mb.e === b.e && mb.w === b.w;
    const sameGrid = sameBounds && this.texSize[0] === f.meta.width && this.texSize[1] === f.meta.height;
    // Uploads bind on unit 0 (saved/restored), with every unpack knob pinned.
    gl.activeTexture(gl.TEXTURE0);
    pinUnpack(gl);
    if (this.fade.frame(sameGrid, now) === "crossfade") {
      // The old "next" becomes "prev"; the new scan goes in the other slot.
      this.nextIdx = 1 - this.nextIdx;
      this.upload(gl, this.tex[this.nextIdx]!, f);
    } else {
      // No honest "previous" on screen (first scan, new crop box, context
      // restore, or back from stale): fill both slots with this scan.
      if (!sameBounds || !this.meshVao) this.buildMesh(gl, b);
      this.upload(gl, this.tex[0]!, f);
      this.upload(gl, this.tex[1]!, f);
      this.texSize = [f.meta.width, f.meta.height];
    }
  }

  private draw(gl: Gl, transformer: any): void {
    if (!this.gl || this.gl !== gl || !this.radarProg || !this.fxProg || !this.smokeProg) return;
    this.redraws++;
    const now = performance.now();
    const saved = saveGl(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    this.takePending(gl, now);

    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const k = this.o.knobs;

    // (1) radar
    const alpha = this.fade.alpha(now);
    if (this.last && this.meshVao && alpha > 0.001) {
      const u = this.radarProg.u;
      gl.useProgram(this.radarProg.p);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const mvp = transformer.fromLatLngAltitude({ lat: this.o.home.lat, lng: this.o.home.lng, altitude: 0 });
      gl.uniformMatrix4fv(u.uMvp!, false, Float32Array.from(mvp));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[1 - this.nextIdx]!);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[this.nextIdx]!);
      gl.uniform1i(u.uPrev!, 0);
      gl.uniform1i(u.uNext!, 1);
      gl.uniform2f(u.uTexSize!, this.texSize[0], this.texSize[1]);
      gl.uniform1f(u.uMix!, this.fade.mix(now));
      gl.uniform1f(u.uAlpha!, alpha);
      gl.uniform1f(u.uMinDbz!, k.radarMinDbz);
      gl.uniform1f(u.uOpacity!, k.radarOpacity);
      gl.bindVertexArray(this.meshVao);
      gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_SHORT, 0);
    }

    // (2) haze + smoke + fronts
    const frame = this.o.getFrame(Date.now());
    this.lastFrame = frame;
    let nf = 0;
    for (const fr of frame.fronts) {
      if (nf >= MAX_FRONTS) break;
      const m = transformer.fromLatLngAltitude({ lat: fr.lat, lng: fr.lng, altitude: 0 });
      const c = clipToPx(m, 0, 0, 0, W, H), e = clipToPx(m, fr.radiusM, 0, 0, W, H);
      if (!c || !e) continue;
      this.fronts.set([c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), fr.ageMs / 1000], nf * 4);
      this.frontsB.set([fr.grow, fr.bright, fr.releasing, 0], nf * 4);
      this.frontsC.set(fr.color, nf * 3);
      nf++;
    }
    let np = 0;
    const px1080 = H / 1080;   // drift is authored at 1080 tall
    for (const p of frame.puffs) {
      if (np >= MAX_PUFFS) break;
      const m = transformer.fromLatLngAltitude({ lat: p.lat, lng: p.lng, altitude: 0 });
      const c = clipToPx(m, 0, 0, 0, W, H), e = clipToPx(m, p.radiusM * k.smokeScale, 0, 0, W, H);
      if (!c || !e) continue;
      // gl px: origin bottom-left, so +y = north
      this.puffsA.set([c[0] + p.drift[0] * px1080, c[1] + p.drift[1] * px1080, Math.hypot(e[0] - c[0], e[1] - c[1]), p.strength], np * 4);
      this.puffsB.set([p.dir[0], p.dir[1], p.along, p.cross], np * 4);
      this.puffsC.set([p.color[0], p.color[1], p.color[2], p.seed], np * 4);
      np++;
    }
    if (np > 0) this.renderSmoke(gl, saved, W, H, np, frame.step % STEP_WRAP);
    if (k.hazeIntensity > 0 || nf > 0 || np > 0) {
      const u = this.fxProg.u;
      gl.useProgram(this.fxProg.p);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform2f(u.uRes!, W, H);
      gl.uniform1f(u.uTime!, (now - this.t0) / 1000);
      gl.uniform1f(u.uHaze!, k.hazeIntensity);
      gl.uniform4fv(u.uFrontA!, this.fronts);
      gl.uniform4fv(u.uFrontB!, this.frontsB);
      gl.uniform3fv(u.uFrontC!, this.frontsC);
      gl.uniform1i(u.uNFronts!, nf);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, np > 0 ? this.smokeTex : null);
      gl.uniform1i(u.uSmoke!, 0);
      gl.uniform1f(u.uHasSmoke!, np > 0 ? 1 : 0);
      gl.bindVertexArray(this.fxVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    restoreGl(gl, saved);
    this.reschedule();
  }

  /** The smoke pass, cached (spec 2026-10-02 glass smoke): render puffs into a
   *  half-res texture only when their packed inputs change (a smoke tick or a
   *  new puff); every other glass frame just samples it. Leaves Google's
   *  framebuffer and viewport as they were. */
  private renderSmoke(gl: Gl, saved: SavedGl, W: number, H: number, np: number, step: number): void {
    const sw = Math.max(1, Math.ceil(W / SMOKE_DOWNSCALE)), sh = Math.max(1, Math.ceil(H / SMOKE_DOWNSCALE));
    const sig = this.smokeSig;
    sig.set(this.puffsA, 0); sig.set(this.puffsB, MAX_PUFFS * 4); sig.set(this.puffsC, MAX_PUFFS * 8);
    sig.set([np, step, W, H], MAX_PUFFS * 12);
    const sized = this.smokeTex && this.smokeSize[0] === sw && this.smokeSize[1] === sh;
    if (!sized) {
      if (!this.smokeTex) this.smokeTex = gl.createTexture();
      if (!this.smokeFbo) this.smokeFbo = gl.createFramebuffer();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.smokeTex);
      pinUnpack(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.smokeFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.smokeTex, 0);
      this.smokeSize = [sw, sh];
      this.smokeCache.invalidate();
    }
    if (!this.smokeCache.stale(sig)) return;
    this.smokeRenders++;
    const k = this.o.knobs, u = this.smokeProg!.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.smokeFbo);
    gl.viewport(0, 0, sw, sh);
    gl.disable(gl.BLEND);                    // opaque write covers every texel: no clear needed
    gl.useProgram(this.smokeProg!.p);
    gl.uniform1f(u.uScale!, W / sw);
    gl.uniform4fv(u.uPuffA!, this.puffsA);
    gl.uniform4fv(u.uPuffB!, this.puffsB);
    gl.uniform4fv(u.uPuffC!, this.puffsC);
    gl.uniform1i(u.uNPuffs!, np);
    gl.uniform1f(u.uStep!, step);
    gl.uniform1f(u.uSmokeBody!, k.smokeBody);
    gl.uniform1f(u.uSparkDensity!, k.sparkDensity);
    gl.bindVertexArray(this.fxVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
    gl.viewport(saved.viewport[0]!, saved.viewport[1]!, saved.viewport[2]!, saved.viewport[3]!);
    gl.enable(gl.BLEND);
  }
}

function link(gl: Gl, vs: string, fs: string, uniforms: string[]): Prog | null {
  const sh = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("[glass] shader compile failed:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error("[glass] program link failed:", gl.getProgramInfoLog(p));
    return null;
  }
  const u: Prog["u"] = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
  return { p, u };
}

export interface SavedGl {
  program: WebGLProgram | null; vao: WebGLVertexArrayObject | null; arrayBuffer: WebGLBuffer | null;
  activeTexture: number; texActive: WebGLTexture | null; tex0: WebGLTexture | null; tex1: WebGLTexture | null;
  blend: boolean; depth: boolean; cull: boolean; stencil: boolean; scissor: boolean;
  srcRgb: number; dstRgb: number; srcA: number; dstA: number; eqRgb: number; eqA: number;
  unpack: number; flipY: boolean; premult: boolean; rowLength: number; skipRows: number; skipPixels: number;
  unpackBuffer: WebGLBuffer | null;
  framebuffer: WebGLFramebuffer | null; viewport: Int32Array;
}

/** Pin every pixel-unpack parameter for a raw R8 upload: Google may leave
 *  FLIP_Y on (radar would render mirrored N/S), a row length/skip (shifted
 *  rows), or a PIXEL_UNPACK_BUFFER bound (texImage2D from an array fails). */
export function pinUnpack(gl: Gl): void {
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
}

export function saveGl(gl: Gl): SavedGl {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  const texActive = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(gl.TEXTURE0);
  const tex0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(gl.TEXTURE1);
  const tex1 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(activeTexture);
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING), activeTexture, texActive, tex0, tex1,
    blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE),
    stencil: gl.isEnabled(gl.STENCIL_TEST), scissor: gl.isEnabled(gl.SCISSOR_TEST),
    srcRgb: gl.getParameter(gl.BLEND_SRC_RGB), dstRgb: gl.getParameter(gl.BLEND_DST_RGB),
    srcA: gl.getParameter(gl.BLEND_SRC_ALPHA), dstA: gl.getParameter(gl.BLEND_DST_ALPHA),
    eqRgb: gl.getParameter(gl.BLEND_EQUATION_RGB), eqA: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    unpack: gl.getParameter(gl.UNPACK_ALIGNMENT),
    flipY: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), premult: gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),
    rowLength: gl.getParameter(gl.UNPACK_ROW_LENGTH), skipRows: gl.getParameter(gl.UNPACK_SKIP_ROWS),
    skipPixels: gl.getParameter(gl.UNPACK_SKIP_PIXELS), unpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING), viewport: gl.getParameter(gl.VIEWPORT),
  };
}

export function restoreGl(gl: Gl, s: SavedGl): void {
  gl.bindVertexArray(s.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuffer);
  gl.useProgram(s.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.tex0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, s.tex1);
  gl.activeTexture(s.activeTexture);
  // Restore the binding on Google's active unit too (uploads may use it
  // before we switch units), after units 0/1 so it wins if it is one of them.
  gl.bindTexture(gl.TEXTURE_2D, s.texActive);
  if (s.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
  if (s.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  if (s.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
  gl.blendFuncSeparate(s.srcRgb, s.dstRgb, s.srcA, s.dstA);
  gl.blendEquationSeparate(s.eqRgb, s.eqA);
  if (s.stencil) gl.enable(gl.STENCIL_TEST); else gl.disable(gl.STENCIL_TEST);
  if (s.scissor) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, s.unpack);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, s.flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, s.premult);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, s.rowLength);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, s.skipRows);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, s.skipPixels);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, s.unpackBuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
  gl.viewport(s.viewport[0]!, s.viewport[1]!, s.viewport[2]!, s.viewport[3]!);
}
