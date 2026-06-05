import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import { BlipField } from "./blips.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import "./map.css";

// Live activity map (ROADMAP Idea 2, Google Maps per operator decision):
// every channel opening / Close Call with a known transmitter site pulses on
// the map and decays over a minute. Backfills the last hour from /api/history
// so the picture is alive from first paint. Honest framing: a blip is the
// REPEATER/TRANSMITTER site, not the person talking.

const BLIP_LIFETIME_MS = 60_000;
const HISTORY_BACKFILL_MS = 3_600_000;

declare const google: any; // loaded dynamically with the configured key

export function renderMap(root: HTMLElement): void {
  root.innerHTML = `<div class="mapWrap">
    <div id="gmap"></div>
    <div class="mapLegend">
      <span class="lgBlip active"></span> channel hit
      <span class="lgBlip cc"></span> close call
      <span class="lgNote">blips mark transmitter sites · fade over 60 s</span>
    </div>
    <div id="mapMsg" class="mapMsg"></div>
  </div>`;
  const msg = root.querySelector<HTMLElement>("#mapMsg")!;

  void api.getConfig().then((cfg) => {
    const key = cfg.display?.googleMapsApiKey;
    if (!key) {
      msg.innerHTML = `No Google Maps API key configured.<br/>
        Add one in the admin's <b>Scan tuning</b> section (Maps JavaScript API, key restricted to this host).`;
      return;
    }
    const center = {
      lat: cfg.display?.weatherLat ?? 39.1,
      lng: cfg.display?.weatherLon ?? -94.58,
    };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    s.onerror = () => { msg.textContent = "Google Maps failed to load (network or key)."; };
    s.onload = () => start(center);
    document.head.appendChild(s);
  });

  function start(center: { lat: number; lng: number }): void {
    const map = new google.maps.Map(root.querySelector("#gmap")!, {
      center, zoom: 10,
      disableDefaultUI: true, zoomControl: true,
      backgroundColor: "#1c1f26",
      styles: DARK_STYLE,
    });

    const field = new BlipField(BLIP_LIFETIME_MS);
    // site key -> rendered circle + label marker
    const circles = new Map<string, { circle: any; info: any }>();

    function push(lat: number, lon: number, alphaTag: string, kind: "active" | "closecall", ts: number): void {
      field.add({ lat, lon, alphaTag, kind, ts });
    }

    // Backfill: the last hour, pre-decayed.
    void fetch(`/api/history?since=${Date.now() - HISTORY_BACKFILL_MS}&limit=500`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ lat: number | null; lon: number | null; alphaTag: string; kind: string; ts: number }>) => {
        for (const r of rows) {
          if (r.lat == null || r.lon == null) continue;
          // map hour-old rows into the blip lifetime tail: scale 1h -> 60s
          const age = Date.now() - r.ts;
          const scaledTs = Date.now() - (age / HISTORY_BACKFILL_MS) * BLIP_LIFETIME_MS;
          push(r.lat, r.lon, r.alphaTag, r.kind === "closecall" ? "closecall" : "active", scaledTs);
        }
      })
      .catch(() => {});

    // Live feed.
    const proto = location.protocol === "https:" ? "wss" : "ws";
    new ReconnectingWs(`${proto}://${location.host}/ws`, (ev: EngineEvent) => {
      if (ev.type === "active" && ev.channel.location?.lat != null && ev.channel.location.lon != null) {
        push(ev.channel.location.lat, ev.channel.location.lon, ev.channel.alphaTag || fmtFreq(ev.freq), "active", Date.now());
      }
      // closecall events carry no location yet (identification is async);
      // the next history backfill will place them once enriched.
    }).connect();

    const COLORS = { active: "#ff6b35", closecall: "#dc3a38" }; // spark / flamingo

    function tick(): void {
      const alive = field.alive(Date.now());
      const seen = new Set<string>();
      for (const b of alive) {
        const key = `${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;
        seen.add(key);
        let entry = circles.get(key);
        if (!entry) {
          const circle = new google.maps.Circle({
            map, center: { lat: b.lat, lng: b.lon },
            radius: 400, strokeWeight: 1.5,
          });
          const info = new google.maps.InfoWindow({ disableAutoPan: true });
          circle.addListener("click", () => {
            info.setContent(`<div class="blipInfo">${esc(b.alphaTag)}</div>`);
            info.setPosition({ lat: b.lat, lng: b.lon });
            info.open({ map });
          });
          entry = { circle, info };
          circles.set(key, entry);
        }
        entry.circle.setOptions({
          radius: 300 + 250 * Math.min(b.hits, 6) + 600 * (1 - b.opacity),
          strokeColor: COLORS[b.kind],
          strokeOpacity: Math.min(1, b.opacity * 1.4),
          fillColor: COLORS[b.kind],
          fillOpacity: 0.28 * b.opacity,
        });
      }
      for (const [key, entry] of circles) {
        if (!seen.has(key)) {
          entry.circle.setMap(null);
          circles.delete(key);
        }
      }
      requestAnimationFrame(() => setTimeout(tick, 200));
    }
    tick();
  }
}

// Instrument-dark cartography to match the kiosk.
const DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1c1f26" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#747b8a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1c1f26" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2b303b" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#42454e" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#13161c" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#262b34" }] },
];
