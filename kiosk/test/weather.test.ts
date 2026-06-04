import { describe, it, expect, vi } from "vitest";
import { NwsWeather } from "../src/backend/weather.js";

const POINTS = { properties: { forecastHourly: "https://api.weather.gov/gridpoints/EAX/44,55/forecast/hourly" } };
const HOURLY = { properties: { periods: [
  { temperature: 38, temperatureUnit: "F", shortForecast: "Partly Cloudy", windSpeed: "10 mph", windDirection: "NW", isDaytime: false },
] } };

function make() {
  const fetcher = vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.includes("/points/") ? POINTS : HOURLY),
  }));
  const wx = new NwsWeather({ lat: 39.277, lon: -94.517, userAgent: "Kerchunk/1.0 (test)", fetcher, ttlMs: 600_000 });
  return { wx, fetcher };
}

describe("NwsWeather", () => {
  it("resolves the gridpoint then reports current conditions", async () => {
    const { wx, fetcher } = make();
    const now = await wx.current();
    expect(now).toEqual({ tempF: 38, condition: "Partly Cloudy", wind: "NW 10 mph", isDaytime: false });
    expect(fetcher.mock.calls[0][0]).toContain("/points/39.277,-94.517");
    expect(fetcher.mock.calls[0][1].headers["User-Agent"]).toBe("Kerchunk/1.0 (test)");
  });

  it("caches: a second call within the TTL does not refetch", async () => {
    const { wx, fetcher } = make();
    await wx.current();
    const n = fetcher.mock.calls.length;
    await wx.current();
    expect(fetcher.mock.calls.length).toBe(n);
  });

  it("degrades to null on failure", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const wx = new NwsWeather({ lat: 1, lon: 1, userAgent: "t", fetcher });
    expect(await wx.current()).toBeNull();
  });
});
