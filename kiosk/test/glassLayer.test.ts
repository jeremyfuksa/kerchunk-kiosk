import { describe, it, expect, vi, afterEach } from "vitest";
import { saveGl, restoreGl, pinUnpack, GlassLayer } from "../src/frontend/map/glassLayer.js";
import { EMPTY_FRAME } from "../src/frontend/map/glassMath.js";

// A recording fake of just the WebGL2 state the glass layer touches. Enum
// values are arbitrary distinct numbers; texture bindings are per unit.
function fakeGl() {
  const E = {
    TEXTURE0: 0x84c0, TEXTURE1: 0x84c1, TEXTURE3: 0x84c3, ACTIVE_TEXTURE: 1, TEXTURE_BINDING_2D: 2, TEXTURE_2D: 3,
    CURRENT_PROGRAM: 4, VERTEX_ARRAY_BINDING: 5, ARRAY_BUFFER_BINDING: 6, ARRAY_BUFFER: 7,
    BLEND: 8, DEPTH_TEST: 9, CULL_FACE: 10, STENCIL_TEST: 11, SCISSOR_TEST: 12,
    BLEND_SRC_RGB: 13, BLEND_DST_RGB: 14, BLEND_SRC_ALPHA: 15, BLEND_DST_ALPHA: 16,
    BLEND_EQUATION_RGB: 17, BLEND_EQUATION_ALPHA: 18,
    UNPACK_ALIGNMENT: 19, UNPACK_FLIP_Y_WEBGL: 20, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 21,
    UNPACK_ROW_LENGTH: 22, UNPACK_SKIP_ROWS: 23, UNPACK_SKIP_PIXELS: 24,
    PIXEL_UNPACK_BUFFER: 25, PIXEL_UNPACK_BUFFER_BINDING: 26,
  };
  const p = new Map<number, unknown>([
    [E.ACTIVE_TEXTURE, E.TEXTURE0], [E.CURRENT_PROGRAM, null], [E.VERTEX_ARRAY_BINDING, null], [E.ARRAY_BUFFER_BINDING, null],
    [E.BLEND_SRC_RGB, 1], [E.BLEND_DST_RGB, 0], [E.BLEND_SRC_ALPHA, 1], [E.BLEND_DST_ALPHA, 0],
    [E.BLEND_EQUATION_RGB, 0x8006], [E.BLEND_EQUATION_ALPHA, 0x8006],
    [E.UNPACK_ALIGNMENT, 4], [E.UNPACK_FLIP_Y_WEBGL, false], [E.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false],
    [E.UNPACK_ROW_LENGTH, 0], [E.UNPACK_SKIP_ROWS, 0], [E.UNPACK_SKIP_PIXELS, 0], [E.PIXEL_UNPACK_BUFFER_BINDING, null],
  ]);
  const enabled = new Set<number>();
  const tex = new Map<number, unknown>();
  const gl = {
    ...E,
    getParameter: (k: number) => (k === E.TEXTURE_BINDING_2D ? tex.get(p.get(E.ACTIVE_TEXTURE) as number) ?? null : p.get(k)),
    activeTexture: (u: number) => { p.set(E.ACTIVE_TEXTURE, u); },
    bindTexture: (_t: number, x: unknown) => { tex.set(p.get(E.ACTIVE_TEXTURE) as number, x); },
    bindBuffer: (t: number, b: unknown) => { p.set(t === E.PIXEL_UNPACK_BUFFER ? E.PIXEL_UNPACK_BUFFER_BINDING : E.ARRAY_BUFFER_BINDING, b); },
    bindVertexArray: (v: unknown) => { p.set(E.VERTEX_ARRAY_BINDING, v); },
    useProgram: (x: unknown) => { p.set(E.CURRENT_PROGRAM, x); },
    isEnabled: (c: number) => enabled.has(c),
    enable: (c: number) => { enabled.add(c); },
    disable: (c: number) => { enabled.delete(c); },
    blendFuncSeparate: (a: number, b: number, c: number, d: number) => { p.set(E.BLEND_SRC_RGB, a); p.set(E.BLEND_DST_RGB, b); p.set(E.BLEND_SRC_ALPHA, c); p.set(E.BLEND_DST_ALPHA, d); },
    blendEquationSeparate: (a: number, b: number) => { p.set(E.BLEND_EQUATION_RGB, a); p.set(E.BLEND_EQUATION_ALPHA, b); },
    pixelStorei: (k: number, v: unknown) => { p.set(k, v); },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, E, p, tex, enabled };
}

describe("glass GL state discipline", () => {
  it("pinUnpack pins every pixel-unpack parameter for a raw R8 upload", () => {
    const { gl, E, p } = fakeGl();
    p.set(E.UNPACK_FLIP_Y_WEBGL, true);           // left on by someone else: would mirror radar N/S
    p.set(E.UNPACK_ROW_LENGTH, 512); p.set(E.UNPACK_SKIP_ROWS, 3); p.set(E.UNPACK_SKIP_PIXELS, 7);
    p.set(E.PIXEL_UNPACK_BUFFER_BINDING, { buf: 1 });
    pinUnpack(gl);
    expect([E.UNPACK_ALIGNMENT, E.UNPACK_FLIP_Y_WEBGL, E.UNPACK_PREMULTIPLY_ALPHA_WEBGL, E.UNPACK_ROW_LENGTH, E.UNPACK_SKIP_ROWS, E.UNPACK_SKIP_PIXELS, E.PIXEL_UNPACK_BUFFER_BINDING].map((k) => p.get(k)))
      .toEqual([1, false, false, 0, 0, 0, null]);
  });

  it("restoreGl puts back unpack state, stencil/scissor, and the binding on Google's ACTIVE unit", () => {
    const { gl, E, p, tex, enabled } = fakeGl();
    p.set(E.UNPACK_FLIP_Y_WEBGL, true); p.set(E.UNPACK_ROW_LENGTH, 64); p.set(E.PIXEL_UNPACK_BUFFER_BINDING, "pbo");
    enabled.add(E.STENCIL_TEST); enabled.add(E.SCISSOR_TEST);
    gl.activeTexture(E.TEXTURE3); gl.bindTexture(E.TEXTURE_2D, "googleTex3" as unknown as WebGLTexture);
    const saved = saveGl(gl);
    // What a draw does: pin unpack, disable stencil/scissor, bind on the current unit.
    pinUnpack(gl);
    gl.disable(E.STENCIL_TEST); gl.disable(E.SCISSOR_TEST);
    gl.bindTexture(E.TEXTURE_2D, "ours" as unknown as WebGLTexture);
    restoreGl(gl, saved);
    expect(tex.get(E.TEXTURE3)).toBe("googleTex3");
    expect(p.get(E.ACTIVE_TEXTURE)).toBe(E.TEXTURE3);
    expect([p.get(E.UNPACK_FLIP_Y_WEBGL), p.get(E.UNPACK_ROW_LENGTH), p.get(E.PIXEL_UNPACK_BUFFER_BINDING)]).toEqual([true, 64, "pbo"]);
    expect(enabled.has(E.STENCIL_TEST) && enabled.has(E.SCISSOR_TEST)).toBe(true);
  });
});

describe("GlassLayer when it can't run", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("an off state stops the redraw loop and unmounts (no standing map redraws for nothing)", () => {
    vi.useFakeTimers();
    const requestRedraw = vi.fn();
    const setMap = vi.fn();
    let ov: any;
    vi.stubGlobal("google", { maps: { WebGLOverlayView: class { constructor() { ov = this; } requestRedraw = requestRedraw; setMap = setMap; } } });
    const knobs = { maxFps: 30, txFps: 60, hazeIntensity: 0.35, radarOpacity: 0.6, radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900, holdFps: 4, signalSteps: 8, fadeSteps: 24 };
    const layer = new GlassLayer({ map: {}, home: { lat: 39, lng: -94 }, knobs, getFrame: () => EMPTY_FRAME });
    ov.onContextRestored({ gl: {} });              // not a WebGL2 context (node has none)
    expect(layer.status).toBe("off:no-webgl2");
    expect(layer.off).toBe(true);
    requestRedraw.mockClear();
    vi.advanceTimersByTime(5_000);
    expect(requestRedraw).not.toHaveBeenCalled();
    expect(setMap).toHaveBeenLastCalledWith(null);
  });
});

describe("GlassLayer pacing", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("a dropped redraw is retried by the 1 s fallback; poke() requests a redraw", () => {
    vi.useFakeTimers();
    const requestRedraw = vi.fn();
    vi.stubGlobal("google", { maps: { WebGLOverlayView: class { requestRedraw = requestRedraw; setMap = vi.fn(); } } });
    const knobs = { maxFps: 30, txFps: 60, hazeIntensity: 0, radarOpacity: 0.6, radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900, holdFps: 4, signalSteps: 8, fadeSteps: 24 };
    const layer = new GlassLayer({ map: {}, home: { lat: 39, lng: -94 }, knobs, getFrame: () => EMPTY_FRAME });
    requestRedraw.mockClear();
    vi.advanceTimersByTime(1000);                 // no draw ever came back: the kick retries
    expect(requestRedraw).toHaveBeenCalled();
    requestRedraw.mockClear();
    layer.poke();
    expect(requestRedraw).toHaveBeenCalledTimes(1);
    expect(layer.takeRedraws()).toBe(0);           // nothing drew (no GL in node)
  });
});

describe("GlassLayer.redrawAt (review I2)", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("arms a redraw for a future moment, and never pushes an earlier timer later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const requestRedraw = vi.fn();
    vi.stubGlobal("google", { maps: { WebGLOverlayView: class { requestRedraw = requestRedraw; setMap = vi.fn(); } } });
    const knobs = { maxFps: 30, txFps: 60, hazeIntensity: 0, radarOpacity: 0.6, radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900, holdFps: 4, signalSteps: 8, fadeSteps: 24 };
    const layer = new GlassLayer({ map: {}, home: { lat: 39, lng: -94 }, knobs, getFrame: () => EMPTY_FRAME });
    layer.redrawAt(10_200);                       // earlier than the 1 s kick → re-armed
    requestRedraw.mockClear();
    vi.advanceTimersByTime(199);
    expect(requestRedraw).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestRedraw).toHaveBeenCalledTimes(1);
    requestRedraw.mockClear();
    layer.redrawAt(10_200 + 5_000);               // later than the armed kick: ignored
    vi.advanceTimersByTime(1_000);
    expect(requestRedraw).toHaveBeenCalledTimes(1); // the kick, not pushed back
  });
});
