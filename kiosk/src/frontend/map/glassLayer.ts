// Weather Glass: one WebGLOverlayView drawing inside Google's own GL context
// (spec 2026-10-01 §1). Per frame: (1) the real-radar mesh, premultiplied;
// (2) an additive full-viewport pass with haze, afterglows and live fronts.
// Pins, aircraft and the edge glow stay Google/DOM objects above it.
//
// GL state discipline: Google owns this context. Every draw saves what it
// touches and restores it, and all texture uploads happen inside onDraw
// (never from a fetch callback), so we never fight the map renderer.
import { RADAR_VS, RADAR_FS, FX_VS, FX_FS } from "./glassShaders.js";
import {
  MAX_FRONTS, MAX_GLOWS, fadeProgress, mercatorOffsetM, clipToPx,
  type GlassFrame,
} from "./glassMath.js";
import type { RadarFrame } from "./radarSync.js";

declare const google: any;

export interface GlassKnobs {
  maxFps: number; txFps: number; hazeIntensity: number; radarOpacity: number;
  radarMinDbz: number; radarFadeMs: number; txGrowMs: number;
}

export interface GlassLayerOptions {
  map: any;
  home: { lat: number; lng: number };
  knobs: GlassKnobs;
  getFrame: (now: number) => GlassFrame;
}

const MESH_DIV = 32; // mesh subdivisions per axis (equirect → Mercator)

type Gl = WebGL2RenderingContext;
interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

export class GlassLayer {
  status = "pending";
  private readonly ov: any;
  private gl: Gl | null = null;
  private radarProg: Prog | null = null;
  private fxProg: Prog | null = null;
  private meshVao: WebGLVertexArrayObject | null = null;
  private meshCount = 0;
  private meshBounds: RadarFrame["meta"]["bounds"] | null = null;
  private fxVao: WebGLVertexArrayObject | null = null;
  private tex: [WebGLTexture | null, WebGLTexture | null] = [null, null];
  private nextIdx = 0;                     // tex[nextIdx] = newest scan
  private texSize: [number, number] = [1, 1];
  private hasRadar = false;
  private pending: RadarFrame | null = null;
  private last: RadarFrame | null = null;  // re-upload after context loss
  private mixStart = 0;
  private alphaFrom = 0;
  private alphaTo = 0;
  private alphaStart = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly t0 = performance.now();
  private readonly fronts = new Float32Array(MAX_FRONTS * 4);
  private readonly frontsB = new Float32Array(MAX_FRONTS * 4);
  private readonly frontsC = new Float32Array(MAX_FRONTS * 3);
  private readonly glows = new Float32Array(MAX_GLOWS * 4);
  private readonly glowsC = new Float32Array(MAX_GLOWS * 3);
  private lastFrame: GlassFrame | null = null;

  constructor(private readonly o: GlassLayerOptions) {
    this.ov = new google.maps.WebGLOverlayView();
    this.ov.onAdd = () => {};
    this.ov.onContextRestored = ({ gl }: { gl: WebGLRenderingContext | Gl }) => this.init(gl);
    this.ov.onContextLost = () => { this.gl = null; this.radarProg = this.fxProg = null; this.meshVao = this.fxVao = null; this.tex = [null, null]; this.meshBounds = null; this.hasRadar = false; this.pending = this.last; };
    this.ov.onDraw = ({ gl, transformer }: { gl: Gl; transformer: any }) => this.draw(gl, transformer);
    this.ov.onRemove = () => {};
    this.ov.setMap(o.map);
    this.schedule();
  }

  setRadar(f: RadarFrame): void { this.pending = f; this.ov.requestRedraw(); }

  setRadarStale(stale: boolean): void {
    this.retargetAlpha(stale ? 0 : 1, performance.now());
    this.ov.requestRedraw();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ov.setMap(null);
  }

  // ── pacing: redraw at maxFps, txFps while a front grows; idle only when
  // nothing can change (haze off, no fronts/glows, no fades running).
  private schedule(): void {
    const now = performance.now();
    const f = this.lastFrame;
    const fading = fadeProgress(this.mixStart, now, this.o.knobs.radarFadeMs) < 1
      || fadeProgress(this.alphaStart, now, this.o.knobs.radarFadeMs) < 1;
    const animating = this.o.knobs.hazeIntensity > 0 || fading
      || !f || f.fronts.length > 0 || f.glows.length > 0;
    if (animating) this.ov.requestRedraw();
    const fps = f?.growing ? this.o.knobs.txFps : this.o.knobs.maxFps;
    this.timer = setTimeout(() => this.schedule(), animating ? 1000 / Math.max(1, fps) : 1000);
  }

  private retargetAlpha(to: number, now: number): void {
    this.alphaFrom = this.currentAlpha(now);
    this.alphaTo = to;
    this.alphaStart = now;
  }

  private currentAlpha(now: number): number {
    const k = fadeProgress(this.alphaStart, now, this.o.knobs.radarFadeMs);
    return this.alphaFrom + (this.alphaTo - this.alphaFrom) * k;
  }

  private init(raw: WebGLRenderingContext | Gl): void {
    if (typeof WebGL2RenderingContext === "undefined" || !(raw instanceof WebGL2RenderingContext)) {
      this.status = "off:no-webgl2";
      return;
    }
    const gl = raw;
    this.radarProg = link(gl, RADAR_VS, RADAR_FS, ["uMvp", "uPrev", "uNext", "uTexSize", "uMix", "uAlpha", "uMinDbz", "uOpacity"]);
    this.fxProg = link(gl, FX_VS, FX_FS, ["uRes", "uTime", "uHaze", "uFrontA", "uFrontB", "uFrontC", "uNFronts", "uGlowA", "uGlowC", "uNGlows"]);
    if (!this.radarProg || !this.fxProg) { this.status = "off:shader"; return; }
    const saved = saveGl(gl);
    this.fxVao = gl.createVertexArray();
    gl.bindVertexArray(this.fxVao);
    const fxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.fxProg.p, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
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
    const sameGrid = this.hasRadar && mb && mb.n === b.n && mb.s === b.s && mb.e === b.e && mb.w === b.w
      && this.texSize[0] === f.meta.width && this.texSize[1] === f.meta.height;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (sameGrid) {
      // Crossfade: the old "next" becomes "prev"; the new scan goes in the other slot.
      this.nextIdx = 1 - this.nextIdx;
      this.upload(gl, this.tex[this.nextIdx]!, f);
      this.mixStart = now;
    } else {
      // First scan (or a new crop box): no honest "previous", so fill both
      // slots and fade the layer in from empty.
      if (!mb || mb.n !== b.n || mb.s !== b.s || mb.e !== b.e || mb.w !== b.w) this.buildMesh(gl, b);
      this.upload(gl, this.tex[0]!, f);
      this.upload(gl, this.tex[1]!, f);
      this.texSize = [f.meta.width, f.meta.height];
      this.mixStart = now - this.o.knobs.radarFadeMs; // mix already complete
      if (!this.hasRadar) this.retargetAlpha(f.meta.stale ? 0 : 1, now);
      this.hasRadar = true;
    }
  }

  private draw(gl: Gl, transformer: any): void {
    if (!this.gl || this.gl !== gl || !this.radarProg || !this.fxProg) return;
    const now = performance.now();
    const saved = saveGl(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    this.takePending(gl, now);

    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const k = this.o.knobs;

    // (1) radar
    const alpha = this.currentAlpha(now);
    if (this.hasRadar && this.meshVao && alpha > 0.001) {
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
      gl.uniform1f(u.uMix!, fadeProgress(this.mixStart, now, k.radarFadeMs));
      gl.uniform1f(u.uAlpha!, alpha);
      gl.uniform1f(u.uMinDbz!, k.radarMinDbz);
      gl.uniform1f(u.uOpacity!, k.radarOpacity);
      gl.bindVertexArray(this.meshVao);
      gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_SHORT, 0);
    }

    // (2) haze + afterglows + fronts
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
    let ng = 0;
    for (const g of frame.glows) {
      if (ng >= MAX_GLOWS) break;
      const m = transformer.fromLatLngAltitude({ lat: g.lat, lng: g.lng, altitude: 0 });
      const c = clipToPx(m, 0, 0, 0, W, H), e = clipToPx(m, g.radiusM, 0, 0, W, H);
      if (!c || !e) continue;
      this.glows.set([c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), g.strength], ng * 4);
      this.glowsC.set(g.color, ng * 3);
      ng++;
    }
    if (k.hazeIntensity > 0 || nf > 0 || ng > 0) {
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
      gl.uniform4fv(u.uGlowA!, this.glows);
      gl.uniform3fv(u.uGlowC!, this.glowsC);
      gl.uniform1i(u.uNGlows!, ng);
      gl.bindVertexArray(this.fxVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    restoreGl(gl, saved);
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

interface SavedGl {
  program: WebGLProgram | null; vao: WebGLVertexArrayObject | null; arrayBuffer: WebGLBuffer | null;
  activeTexture: number; tex0: WebGLTexture | null; tex1: WebGLTexture | null;
  blend: boolean; depth: boolean; cull: boolean;
  srcRgb: number; dstRgb: number; srcA: number; dstA: number; eqRgb: number; eqA: number;
  unpack: number;
}

function saveGl(gl: Gl): SavedGl {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0);
  const tex0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(gl.TEXTURE1);
  const tex1 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(activeTexture);
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING), activeTexture, tex0, tex1,
    blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE),
    srcRgb: gl.getParameter(gl.BLEND_SRC_RGB), dstRgb: gl.getParameter(gl.BLEND_DST_RGB),
    srcA: gl.getParameter(gl.BLEND_SRC_ALPHA), dstA: gl.getParameter(gl.BLEND_DST_ALPHA),
    eqRgb: gl.getParameter(gl.BLEND_EQUATION_RGB), eqA: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    unpack: gl.getParameter(gl.UNPACK_ALIGNMENT),
  };
}

function restoreGl(gl: Gl, s: SavedGl): void {
  gl.bindVertexArray(s.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuffer);
  gl.useProgram(s.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.tex0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, s.tex1);
  gl.activeTexture(s.activeTexture);
  if (s.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
  if (s.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  if (s.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
  gl.blendFuncSeparate(s.srcRgb, s.dstRgb, s.srcA, s.dstA);
  gl.blendEquationSeparate(s.eqRgb, s.eqA);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, s.unpack);
}
