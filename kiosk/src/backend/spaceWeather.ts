// Solar flux, Kp and NOAA's R/S/G storm scales for the HF wall, from NOAA SWPC's public JSON.
// These change slowly, so a wall poll answers from the cache at once and at most starts a refresh
// behind it: the wall polls one request at a time, and a hung NOAA must not hold up /api/status.
// Each product stands alone: one failing keeps its last good value and never costs the other two.

export interface SpaceWeatherNow {
  solarFlux: number | null;
  kp: number | null;
  /** NOAA scale level, 0 = none. */
  r: number | null;
  s: number | null;
  g: number | null;
}

const BASE = "https://services.swpc.noaa.gov/products";

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SpaceWeatherOptions {
  ttlMs: number;
  /** A value older than this is dropped: a dead feed must not show old conditions as current. */
  staleMaxMs?: number;
  fetcher?: Fetcher;
  now?: () => number;
}

interface Product<K extends keyof SpaceWeatherNow> {
  path: string;
  fields: readonly K[];
  /** Null fields mean NOAA's reply wasn't usable. */
  parse(body: unknown): Pick<SpaceWeatherNow, K> | null;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const flux: Product<"solarFlux"> = {
  path: "summary/10cm-flux.json",
  fields: ["solarFlux"],
  parse(body) {
    const solarFlux = Array.isArray(body) ? finite((body[0] as { flux?: unknown } | undefined)?.flux) : null;
    return solarFlux === null ? null : { solarFlux };
  },
};

const kIndex: Product<"kp"> = {
  path: "noaa-planetary-k-index.json",
  fields: ["kp"],
  parse(body) {
    const kp = Array.isArray(body) ? finite((body.at(-1) as { Kp?: unknown } | undefined)?.Kp) : null;
    return kp === null ? null : { kp };
  },
};

const scale = (v: { Scale?: unknown } | undefined): number | null => {
  const n = typeof v?.Scale === "string" && v.Scale !== "" ? Number(v.Scale) : NaN;
  return Number.isInteger(n) ? n : null;
};

const scales: Product<"r" | "s" | "g"> = {
  path: "noaa-scales.json",
  fields: ["r", "s", "g"],
  parse(body) {
    const cur = (body as Record<string, { R?: { Scale?: unknown }; S?: { Scale?: unknown }; G?: { Scale?: unknown } }> | null)?.["0"];
    const [r, s, g] = [scale(cur?.R), scale(cur?.S), scale(cur?.G)];
    return r === null || s === null || g === null ? null : { r, s, g };
  },
};

export class SpaceWeather {
  private readonly ttlMs: number;
  private readonly staleMaxMs: number;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private checkedAt: number | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly good = new Map<keyof SpaceWeatherNow, { at: number; value: number }>();

  constructor(opts: SpaceWeatherOptions) {
    this.ttlMs = opts.ttlMs;
    this.staleMaxMs = opts.staleMaxMs ?? 6 * 3_600_000;
    this.fetcher = opts.fetcher ?? ((url) => fetch(url, { signal: AbortSignal.timeout(15_000) }));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Never throws. Anything NOAA hasn't given us recently is null. */
  current(): SpaceWeatherNow {
    void this.refreshIfDue();
    const read = (k: keyof SpaceWeatherNow): number | null => {
      const v = this.good.get(k);
      return v && this.now() - v.at <= this.staleMaxMs ? v.value : null;
    };
    return { solarFlux: read("solarFlux"), kp: read("kp"), r: read("r"), s: read("s"), g: read("g") };
  }

  refreshIfDue(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (this.checkedAt !== null && this.now() - this.checkedAt < this.ttlMs) return Promise.resolve();
    this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // One at a time: the appliance has deadlocked on concurrent work, and these are not urgent.
  private async refresh(): Promise<void> {
    await this.load(flux);
    await this.load(kIndex);
    await this.load(scales);
    this.checkedAt = this.now();
  }

  private async load<K extends keyof SpaceWeatherNow>(p: Product<K>): Promise<void> {
    try {
      const res = await this.fetcher(`${BASE}/${p.path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = p.parse(await res.json());
      if (!parsed) throw new Error("unexpected reply");
      for (const k of p.fields) this.good.set(k, { at: this.now(), value: parsed[k] as number });
    } catch (e) {
      console.warn(`[space-weather] ${p.path}: ${(e as Error).message}`);
    }
  }
}
