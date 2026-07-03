// Current conditions from the National Weather Service API for the kiosk
// header. Free, keyless, government data — exactly right for an appliance.
// NWS asks integrators to identify with a User-Agent and not to hammer:
// the gridpoint resolution is cached for the process lifetime and the
// hourly forecast for ttlMs (default 10 min).

export interface CurrentWx {
  tempF: number;
  condition: string;
  wind: string;
  isDaytime: boolean;
}

export interface NwsWeatherOptions {
  lat: number;
  lon: number;
  userAgent: string;
  ttlMs?: number;
  /** Stop serving stale conditions once the cache is older than this
   *  (default 2 h). A permanently-failing feed must not show hours-old
   *  weather forever. */
  staleMaxMs?: number;
  fetcher?: (url: string, init: { headers: Record<string, string> })
    => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

interface NwsPoints { properties?: { forecastHourly?: string } }
interface NwsHourly {
  properties?: {
    periods?: Array<{
      temperature?: number;
      shortForecast?: string;
      windSpeed?: string;
      windDirection?: string;
      isDaytime?: boolean;
    }>;
  };
}

export class NwsWeather {
  private readonly opts: Required<NwsWeatherOptions>;
  private hourlyUrl: string | null = null;
  private cached: { at: number; wx: CurrentWx } | null = null;

  constructor(opts: NwsWeatherOptions) {
    this.opts = {
      ttlMs: 10 * 60 * 1000,
      staleMaxMs: 2 * 60 * 60 * 1000,
      fetcher: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
      ...opts,
    };
  }

  /** Latest conditions, or null on any failure (the kiosk just omits the line). */
  async current(): Promise<CurrentWx | null> {
    if (this.cached && Date.now() - this.cached.at < this.opts.ttlMs) {
      return this.cached.wx;
    }
    try {
      const headers = { "User-Agent": this.opts.userAgent, Accept: "application/geo+json" };
      if (!this.hourlyUrl) {
        const res = await this.opts.fetcher(
          `https://api.weather.gov/points/${this.opts.lat},${this.opts.lon}`, { headers });
        if (!res.ok) return this.stale();
        this.hourlyUrl = (await res.json() as NwsPoints).properties?.forecastHourly ?? null;
        if (!this.hourlyUrl) return this.stale();
      }
      const res = await this.opts.fetcher(this.hourlyUrl, { headers });
      if (!res.ok) {
        // A gridpoint forecast URL 404/410s after NWS re-issues the grid.
        // Drop it so the next call re-resolves from /points instead of
        // failing forever; other statuses are likely transient.
        if (res.status === 404 || res.status === 410) this.hourlyUrl = null;
        return this.stale();
      }
      const period = (await res.json() as NwsHourly).properties?.periods?.[0];
      if (!period || typeof period.temperature !== "number") return this.stale();
      const wx: CurrentWx = {
        tempF: period.temperature,
        condition: period.shortForecast ?? "",
        wind: [period.windDirection, period.windSpeed].filter(Boolean).join(" "),
        isDaytime: period.isDaytime ?? true,
      };
      this.cached = { at: Date.now(), wx };
      return wx;
    } catch {
      return this.stale();
    }
  }

  /** On failure, serve the stale cache rather than blanking the display —
   *  but only up to staleMaxMs, so a permanently-failing feed eventually
   *  drops the line instead of showing hours-old conditions indefinitely. */
  private stale(): CurrentWx | null {
    if (!this.cached) return null;
    if (Date.now() - this.cached.at > this.opts.staleMaxMs) return null;
    return this.cached.wx;
  }
}
