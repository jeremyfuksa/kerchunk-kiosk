import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import { BlipField, syntheticPoint, coverageRadiusM } from "./blips.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import icoTower from "lucide-static/icons/radio-tower.svg?raw";
import { serviceFor } from "../../backend/config/banks.js";
// Operator-designed service pins (claude.ai/design handoff, 2026-06-07):
// cream teardrops with vivid service heads; Home is deliberately inverted
// (spark ring, cream head) so the QTH reads as YOURS on the dark map.
import pinAir from "./pins/pin-air.svg?raw";
import pinRail from "./pins/pin-rail.svg?raw";
import pinHam from "./pins/pin-ham.svg?raw";
import pinGmrs from "./pins/pin-gmrs.svg?raw";
import pinBiz from "./pins/pin-biz.svg?raw";
import pinMarine from "./pins/pin-marine.svg?raw";
import pinWeather from "./pins/pin-weather.svg?raw";
import pinUnknown from "./pins/pin-unknown.svg?raw";
import pinHome from "./pins/pin-home.svg?raw";
import "./map.css";

// Lucide SVGs as Google Maps marker icons: bake the color in (markers can't
// inherit currentColor) and serve as a data URL.
// Service pin -> marker icon. 46x56 teardrop; the TIP is the site, so the
// anchor sits at bottom-center. Width in CSS px; height keeps the ratio.
function pinMarker(svg: string, w: number): any {
  const h = Math.round((w * 56) / 46);
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(w, h),
    anchor: new google.maps.Point(w / 2, h),
  };
}

// Which pin does a frequency's service wear? The full operator-designed
// family covers every allocation; anything unclassified gets the gray "?"
// pin, which deliberately recedes next to the vivid services.
function pinFor(freqHz: number): string {
  const svc = serviceFor(freqHz);
  if (svc === "air") return pinAir;
  if (svc === "rail") return pinRail;
  if (svc?.startsWith("ham")) return pinHam;
  if (svc === "GMRS/FRS") return pinGmrs;
  if (svc === "marine") return pinMarine;
  if (svc === "NOAA wx") return pinWeather;
  if (svc && (svc.includes("biz") || svc.includes("PS") || svc.includes("trunked") || svc === "T-band")) return pinBiz;
  return pinUnknown;
}

// The pin heads' palette, applied to the TRANSIENT layer too (operator:
// "match the blip colors to the pins") — a rail hit pulses train-orange,
// a ham hit pink. Frequencies outside the family pulse the unknown gray.
const PIN_COLORS: Record<string, string> = {
  air: "#3478F5", rail: "#F5821F", ham: "#EC4E89", gmrs: "#1FA84C",
  biz: "#7C4FE0", marine: "#0FAEC0", weather: "#F4B315", unknown: "#747B8A",
};
const UNKNOWN_POSITION_COLOR = "#4a7c7e";

function colorFor(freqHz: number | undefined, kind: "active" | "closecall" | "nofix"): string {
  // Synthetic unknown positions must read as uncertain geography, even when
  // the frequency falls inside a recognizable service allocation.
  if (kind === "nofix") return UNKNOWN_POSITION_COLOR;
  if (freqHz === undefined) return kind === "closecall" ? "#dc3a38" : "#ff6b35";
  const svc = serviceFor(freqHz);
  if (svc === "air") return PIN_COLORS.air!;
  if (svc === "rail") return PIN_COLORS.rail!;
  if (svc?.startsWith("ham")) return PIN_COLORS.ham!;
  if (svc === "GMRS/FRS") return PIN_COLORS.gmrs!;
  if (svc === "marine") return PIN_COLORS.marine!;
  if (svc === "NOAA wx") return PIN_COLORS.weather!;
  if (svc && (svc.includes("biz") || svc.includes("PS") || svc.includes("trunked") || svc === "T-band")) return PIN_COLORS.biz!;
  return PIN_COLORS.unknown!;
}

// Live activity map (ROADMAP Idea 2, Google Maps per operator decision):
// every channel opening / Close Call with a known transmitter site pulses on
// the map and decays over a minute. Backfills the last hour from /api/history
// so the picture is alive from first paint. Honest framing: a blip is the
// REPEATER/TRANSMITTER site, not the person talking.

const BLIP_LIFETIME_MS = 60_000;
const HISTORY_BACKFILL_MS = 3_600_000;

declare const google: any; // loaded dynamically with the configured key

// The full-page /map view: the activity map plus its legend. The kiosk
// dashboard mounts the SAME map via mountActivityMap (map-as-stage), without
// the legend and without input affordances.
export function renderMap(root: HTMLElement): void {
  root.innerHTML = `<div class="mapWrap">
    <div id="gmap"></div>
    <div class="mapLegend">
      <span class="lgAnt"></span> pins = sites by service · gray ? = unclassified
      <span class="lgNote">pine pulses = stable synthetic position, location unknown · weather = live NEXRAD</span>
    </div>
    <div id="mapMsg" class="mapMsg"></div>
  </div>`;
  const msg = root.querySelector<HTMLElement>("#mapMsg")!;
  root.querySelector<HTMLElement>(".lgAnt")!.innerHTML = icoTower;

  void mountActivityMap(root.querySelector<HTMLElement>("#gmap")!, { interactive: true })
    .then((mounted) => {
      if (!mounted) {
        msg.innerHTML = `No Google Maps API key configured.<br/>
        Add one in the admin's <b>Scan tuning</b> section (Maps JavaScript API, key restricted to this host).`;
      }
    })
    .catch(() => { msg.textContent = "Google Maps failed to load (network or key)."; });
}

export interface ActivityMapOptions {
  /** false = output-only surface (the kiosk): no zoom control, no gestures. */
  interactive?: boolean;
}

/**
 * Mount the live activity map into `host`. Resolves false when no Maps API
 * key is configured (the caller keeps its non-map layout); rejects when the
 * Maps script itself fails to load.
 */
export async function mountActivityMap(host: HTMLElement, opts: ActivityMapOptions = {}): Promise<boolean> {
  const interactive = opts.interactive !== false;
  const cfg = await api.getConfig();
  const key = cfg.display?.googleMapsApiKey;
  if (!key) return false;
  const home = {
    lat: cfg.display?.weatherLat ?? 39.1,
    lng: cfg.display?.weatherLon ?? -94.58,
  };
  const framing = {
    center: {
      lat: cfg.display?.mapLat ?? home.lat,
      lng: cfg.display?.mapLon ?? home.lng,
    },
    zoom: cfg.display?.mapZoom ?? 10,
  };
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    s.onerror = () => reject(new Error("maps script failed"));
    s.onload = () => resolve();
    document.head.appendChild(s);
  });
  start(host, home, framing, cfg.display?.googleMapsMapId, interactive);
  return true;

  function start(root: HTMLElement, home: { lat: number; lng: number }, framing: { center: { lat: number; lng: number }; zoom: number }, mapId?: string, interactive = true): void {
    // With a cloud-console Map ID the map renders as VECTOR and fitBounds
    // can land on fractional zooms (z9.7) — an exact fit to the pin field.
    // Raster maps floor to integer zoom, showing up to double the area.
    // Vector styling lives in the console; in-code styles are raster-only.
    // Marker scale: the kiosk (output-only) is read from across the room —
    // icons get ~1.6x; the interactive /map page is at arm's length.
    const mk = interactive ? 1 : 1.6;
    // Geographic scale for blips/pings: metro-wide framing needs km-class
    // circles to register at all; the kiosk gets an extra bump on top.
    const geo = interactive ? 1 : 1.6;
    const map = new google.maps.Map(root, {
      center: framing.center, zoom: framing.zoom,
      disableDefaultUI: true,
      zoomControl: interactive,
      gestureHandling: interactive ? "greedy" : "none",
      keyboardShortcuts: interactive,
      backgroundColor: "#1c1f26",
      ...(mapId
        // colorScheme keeps the base map dark even while the console style
        // is unassociated or still propagating — never a white flash.
        ? { mapId, isFractionalZoomEnabled: true, colorScheme: "DARK" }
        : { styles: DARK_STYLE }),
    });

    // ── NEXRAD radar overlay (ROADMAP Idea 2 follow-on, the SAME cross-tie:
    // a warning banner with live precipitation under it). IEM's keyless
    // cached composite — free, US-wide, Web Mercator, ~5 min volume scans.
    // Transparent wherever there's no weather, so a dry day costs nothing;
    // offline it just 404s to absence. Tile overlays render under every
    // marker/circle, so blips and coverage stay on top.
    const RADAR_REFRESH_MS = 5 * 60_000;
    let radarEpoch = Date.now();
    function radarLayer(): any {
      return new google.maps.ImageMapType({
        getTileUrl: (c: { x: number; y: number }, z: number) =>
          `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/${z}/${c.x}/${c.y}.png?_=${radarEpoch}`,
        tileSize: new google.maps.Size(256, 256),
        opacity: 0.55,
        name: "nexrad",
      });
    }
    map.overlayMapTypes.push(radarLayer());
    setInterval(() => {
      // Swap in a fresh epoch so tiles re-fetch past the browser cache.
      radarEpoch = Date.now();
      map.overlayMapTypes.pop();
      map.overlayMapTypes.push(radarLayer());
    }, RADAR_REFRESH_MS);

    // Home: the kiosk's own antenna. Small, dim, unmistakable.
    new google.maps.Marker({
      map, position: home, title: "Kerchunk QTH",
      icon: pinMarker(pinHome, Math.round(26 * mk)),
      zIndex: 1,
    });

    // ── Auto-framing: the QTH is the NORTHERN border of the resting view. We
    // fit the home, a minimum local field, and the nearest ~90% of known sites
    // — but every framed point is clamped to home's latitude or below, so the
    // lone northern outlier (the Cameron site) stays off the top edge. Cameron
    // still pops a live blip + camera punch when it actually transmits; it just
    // isn't part of the steady view. Computed fresh at each fit.
    const SYNTHETIC_FIELD_M = 18_000; // min view radius — never a parking lot
    const NEIGHBORHOOD_DEG = 3;       // ~300 km: a corrupt (0,0) row can't yank the view
    const FRAME_COVER = 0.9;          // fraction of the (nearest) dots the view holds
    function framedBounds(): google.maps.LatLngBounds {
      const b = new google.maps.LatLngBounds();
      const cosLat = Math.cos(home.lat * Math.PI / 180);
      // Clamp latitude to home's: home is the north border of the view.
      const ext = (lat: number, lng: number) => b.extend({ lat: Math.min(lat, home.lat), lng });
      ext(home.lat, home.lng);
      // Minimum local field — east/south/west only; home itself caps the north.
      for (const angle of [Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        ext(
          home.lat + (SYNTHETIC_FIELD_M * Math.cos(angle)) / 111_320,
          home.lng + (SYNTHETIC_FIELD_M * Math.sin(angle)) / (111_320 * cosLat),
        );
      }
      // Nearest FRAME_COVER of the in-neighborhood dots, by distance² from home.
      const near = knownPositions
        .filter((p) => Math.abs(p.lat - home.lat) < NEIGHBORHOOD_DEG
                    && Math.abs(p.lng - home.lng) < NEIGHBORHOOD_DEG)
        .map((p) => {
          const dlat = p.lat - home.lat, dlng = (p.lng - home.lng) * cosLat;
          return { p, d2: dlat * dlat + dlng * dlng };
        })
        .sort((a, z) => a.d2 - z.d2);
      const keep = Math.ceil(near.length * FRAME_COVER);
      for (let i = 0; i < keep; i++) ext(near[i]!.p.lat, near[i]!.p.lng);
      return b;
    }

    const field = new BlipField(BLIP_LIFETIME_MS);
    // site key -> rendered circle + label marker (+ last-written style for the
    // tick() dirty-check, so unchanged blips skip the WebGL re-upload).
    const circles = new Map<string, { circle: any; info: any; last: any }>();
    // Live transmission rings: while a transmission is OPEN, a ring pulses at
    // its site, expanding out to the site's tx (coverage) radius and looping —
    // so it lasts as long as the transmission and stays visible even when the
    // camera is pulled out wide (the old fixed ~5 km one-shot vanished there).
    // Tied to the open->close lifecycle: active/closecall start it, release/idle
    // end it; TX_TTL_MS is a safety cap if a release is ever missed.
    const PULSE_MS = 1800;       // one expand-and-fade cycle of the ring
    const TX_TTL_MS = 30_000;
    const liveTx = new Map<string, { lat: number; lng: number; key: string; color: string; born: number; until: number }>();
    const txRings = new Map<string, any>();
    // The render loop self-suspends on a quiet map; wake() (defined with tick)
    // restarts it. `ticking` guards against double-starting.
    let ticking = false;

    function startTx(id: string, lat: number, lng: number, freq: number | undefined, kind: "active" | "closecall", ttlMs = TX_TTL_MS): void {
      const now = Date.now();
      const existing = liveTx.get(id);
      liveTx.set(id, {
        lat, lng, key: `${lat.toFixed(5)},${lng.toFixed(5)}`,
        color: colorFor(freq, kind), born: existing?.born ?? now, until: now + ttlMs,
      });
      wake();
    }
    function endTx(id: string): void {
      liveTx.delete(id);
      const ring = txRings.get(id);
      if (ring) { ring.setMap(null); txRings.delete(id); }
    }

    // ── Persistent antenna layer: any site heard at least once gets a small
    // mast icon that STAYS — the map remembers the RF neighborhood; live
    // pulses play on top of it. (The per-site "heat" glow disc was removed —
    // it wasn't reading as meaningful; revisit if a better heat idea lands.)
    const antennas = new Map<string, any>();
    const siteInfo = new google.maps.InfoWindow({ disableAutoPan: true });

    function antenna(lat: number, lon: number, names: string[], hits: number, lastTs: number, increment = false): void {
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      const existing = antennas.get(key);
      if (existing) {
        existing.names = Array.from(new Set([...existing.names, ...names]));
        // Seeds carry cumulative store counts (merge = max); a live hit is one
        // MORE transmission (merge = increment) — kept for the info-window count.
        existing.hits = increment ? existing.hits + hits : Math.max(existing.hits, hits);
        existing.lastTs = Math.max(existing.lastTs, lastTs);
        return;
      }
      const pin = sitePin.get(key) ?? pinUnknown;
      const marker = new google.maps.Marker({
        map, position: { lat, lng: lon },
        icon: pinMarker(pin, Math.round(22 * mk)),
        title: names.join(", "),
      });
      const entry = { marker, names: [...names], hits, lastTs };
      marker.addListener("click", () => {
        siteInfo.setContent(`<div class="blipInfo">${entry.names.map((n: string) => esc(n)).join("<br/>")}
          <div class="blipMeta">${entry.hits} hit${entry.hits === 1 ? "" : "s"} · last ${new Date(entry.lastTs).toLocaleTimeString()}</div></div>`);
        siteInfo.setPosition({ lat, lng: lon });
        siteInfo.open({ map });
      });
      antennas.set(key, entry);
    }

    // Located channels frame the view even before they're first heard —
    // and power-rated licenses (FCC) register their estimated coverage so
    // the site's blips render at physical size instead of the hit ramp.
    // Each site also learns its SERVICE PIN here (first located channel at
    // the site decides; ties at multi-service sites go to the first).
    const coverage = new Map<string, number>(); // site key -> radius m
    const sitePin = new Map<string, string>();  // site key -> pin svg
    const knownPositions: Array<{ lat: number; lng: number }> = [];
    const channelsReady = fetch("/api/channels")
      .then((r) => (r.ok ? r.json() : []))
      .then((chs: Array<{ freq: number; location?: { lat?: number; lon?: number; powerWatts?: number; antennaHaatM?: number } }>) => {
        for (const c of chs) {
          if (c.location?.lat != null && c.location.lon != null) {
            knownPositions.push({ lat: c.location.lat, lng: c.location.lon });
            const key = `${c.location.lat.toFixed(5)},${c.location.lon.toFixed(5)}`;
            if (c.location.powerWatts) {
              coverage.set(key, coverageRadiusM(c.location.powerWatts, c.location.antennaHaatM));
            }
            if (!sitePin.has(key)) sitePin.set(key, pinFor(c.freq));
          }
        }
      })
      .catch(() => {});

    // Seed from everything the store has ever located — AFTER the channel
    // fetch resolves, so each site already knows its service pin.
    const sitesReady = channelsReady.then(() => fetch("/api/history/sites")
      .then((r) => (r.ok ? r.json() : []))
      .then((sites: Array<{ lat: number; lon: number; hits: number; lastTs: number; names: string[] }>) => {
        for (const sgt of sites) {
          antenna(sgt.lat, sgt.lon, sgt.names, sgt.hits, sgt.lastTs);
          knownPositions.push({ lat: sgt.lat, lng: sgt.lon });
        }
      }))
      .catch(() => {});


    // Wait for the map's first idle as well as the data: fitBounds against
    // a not-yet-laid-out viewport computes minimum zoom (the whole world).
    // Kiosk padding is asymmetric: the map runs UNDER the floating topbar
    // and the now-playing card, so the fit must keep pins clear of both —
    // Cameron (northernmost) hid behind the bar with uniform 56px.
    const fitPad = interactive
      ? 56
      : { top: 150, left: 120, right: 70, bottom: 70 };
    const mapReady = new Promise<void>((resolve) =>
      google.maps.event.addListenerOnce(map, "idle", resolve));
    void Promise.allSettled([sitesReady, channelsReady, mapReady])
      .then(() => {
        map.fitBounds(framedBounds(), fitPad);
        // Remember the home zoom once the fit settles — the punch zoom and
        // the pull-back both reference it.
        google.maps.event.addListenerOnce(map, "idle", () => { homeZoom = map.getZoom(); });
      });

    // ── Activity camera (kiosk only): when a channel becomes AUDIBLE, ease in
    // toward it (it follows the speaker, not bare detections — see the audible
    // handler); when the band goes quiet, pull back out to the full
    // pin field. Vector maps animate panTo/setZoom natively, so this reads
    // as camera work, not jumps. The interactive /map page never moves on
    // its own — a self-steering camera fights the user's mouse.
    const PUNCH_HOLD_MS = 12_000;   // quiet time before pulling back out
    const PUNCH_ZOOM_IN = 2;        // levels closer than the home framing
    let homeZoom: number | null = null;
    let punchedUntil = 0;
    function punch(lat: number, lng: number): void {
      if (interactive) return;
      punchedUntil = Date.now() + PUNCH_HOLD_MS;
      map.panTo({ lat, lng });
      map.setZoom(Math.min((homeZoom ?? map.getZoom()) + PUNCH_ZOOM_IN, 13));
    }
    if (!interactive) {
      setInterval(() => {
        if (punchedUntil && Date.now() >= punchedUntil) {
          punchedUntil = 0;
          map.fitBounds(framedBounds(), fitPad);
        }
      }, 1500);
    }

    // Unknown-frequency assignments stay fixed for this map session. Their
    // initial position is chosen against all known sites loaded so far; once a
    // later lookup supplies a real location, future events naturally use it.
    const syntheticPositions = new Map<number, { lat: number; lng: number }>();

    function nofix(freqHz: number, alphaTag: string, ts: number): void {
      let pos = syntheticPositions.get(freqHz);
      if (!pos) {
        pos = syntheticPoint(home, SYNTHETIC_FIELD_M, freqHz, knownPositions);
        syntheticPositions.set(freqHz, pos);
      }
      field.add({ lat: pos.lat, lon: pos.lng, alphaTag, kind: "nofix", ts, freq: freqHz });
      wake(); // a blip was planted (live or backfilled) — ensure the loop runs
      // The pulse ring (startTx) and the camera punch (audible) are driven from
      // the WS handler; detection itself just plants the blip.
    }

    function push(lat: number, lon: number, alphaTag: string, kind: "active" | "closecall", ts: number, freq?: number): void {
      field.add({ lat, lon, alphaTag, kind, ts, freq });
      wake(); // a blip was planted (live or backfilled) — ensure the loop runs
      // Live hits plant/refresh the persistent antenna. The pulse ring (startTx)
      // and the camera punch (audible) are driven from the WS handler, not here.
      if (Date.now() - ts < 2000) antenna(lat, lon, [alphaTag], 1, ts, true);
    }

    // Backfill: the last hour, pre-decayed.
    void fetch(`/api/history?since=${Date.now() - HISTORY_BACKFILL_MS}&limit=500`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ lat: number | null; lon: number | null; alphaTag: string; kind: string; ts: number; freq: number }>) => {
        for (const r of rows) {
          if (r.lat == null || r.lon == null) continue;
          // map hour-old rows into the blip lifetime tail: scale 1h -> 60s
          const age = Date.now() - r.ts;
          const scaledTs = Date.now() - (age / HISTORY_BACKFILL_MS) * BLIP_LIFETIME_MS;
          push(r.lat, r.lon, r.alphaTag, r.kind === "closecall" ? "closecall" : "active", scaledTs, r.freq);
        }
      })
      .catch(() => {});

    // Live feed.
    const proto = location.protocol === "https:" ? "wss" : "ws";
    new ReconnectingWs(`${proto}://${location.host}/ws`, (ev: EngineEvent) => {
      if (ev.type === "active") {
        const ch = ev.channel;
        if (ch.location?.lat != null && ch.location.lon != null) {
          push(ch.location.lat, ch.location.lon, ch.alphaTag || fmtFreq(ev.freq), "active", Date.now(), ev.freq);
          startTx(ch.id, ch.location.lat, ch.location.lon, ev.freq, "active");
        } else {
          nofix(ev.freq, ch.alphaTag || fmtFreq(ev.freq), Date.now());
          const pos = syntheticPositions.get(ev.freq);
          if (pos) startTx(ch.id, pos.lat, pos.lng, ev.freq, "active");
        }
      } else if (ev.type === "release") {
        endTx(ev.channelId); // transmission closed — stop its ring
      } else if (ev.type === "idle") {
        for (const id of [...liveTx.keys()]) endTx(id); // all closed
      } else if (ev.type === "closecall") {
        // discoveries are unlocated at the moment they fire (identification
        // is async) — they pulse at a stable synthetic position; once enriched,
        // future events and history backfills place them properly. No release
        // ever arrives for a discovery, so the ring self-expires on its ttl.
        nofix(ev.freqHz, `Close Call ${fmtFreq(ev.freqHz)}`, Date.now());
        const pos = syntheticPositions.get(ev.freqHz);
        if (pos) startTx(`cc_${ev.freqHz}`, pos.lat, pos.lng, ev.freqHz, "closecall", 5000);
      } else if (ev.type === "audible") {
        // Camera follows AUDIO: punch to whatever owns the speaker right now,
        // at its real location or its stable synthetic spot. null = silence —
        // hold the last view; the pull-back timer recenters after PUNCH_HOLD_MS.
        const ch = ev.channel;
        if (ch) {
          if (ch.location?.lat != null && ch.location.lon != null) {
            punch(ch.location.lat, ch.location.lon);
          } else {
            const pos = syntheticPositions.get(ch.freq);
            if (pos) punch(pos.lat, pos.lng);
          }
        }
      }
    }).connect();

    // Restart the render loop after a quiet period. tick() self-suspends (sets
    // ticking=false) when nothing is alive and no transmission ring is live;
    // every activity entry point (push/nofix/startTx) calls wake() so a hit
    // after silence repaints.
    function wake(): void { if (!ticking) { ticking = true; tick(); } }
    function tick(): void {
      const now = Date.now();
      const alive = field.alive(now);
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
          entry = { circle, info, last: null };
          circles.set(key, entry);
        }
        const col = colorFor(b.freq, b.kind);
        // Quantize the 60s opacity fade to ~16 steps so steady-state decay
        // rarely changes a written value — the dirty-check then skips the
        // (geometry+style) WebGL re-upload. Imperceptible at a 60s fade.
        const op = Math.round(b.opacity * 16) / 16;
        const opts = {
          // Power-rated sites blip at ESTIMATED COVERAGE (true geography, no
          // kiosk scale factor); the rest use the hit-count ramp.
          radius: coverage.get(key) ?? (3750 + 625 * Math.min(b.hits, 6)) * geo,
          strokeColor: col,
          strokeOpacity: Math.min(1, op * 1.4),
          fillColor: col,
          fillOpacity: 0.3 * op,
        };
        const last = entry.last;
        if (!last || last.radius !== opts.radius || last.strokeColor !== opts.strokeColor
            || last.strokeOpacity !== opts.strokeOpacity || last.fillColor !== opts.fillColor
            || last.fillOpacity !== opts.fillOpacity) {
          entry.circle.setOptions(opts);
          entry.last = opts;
        }
      }
      for (const [key, entry] of circles) {
        if (!seen.has(key)) {
          entry.circle.setMap(null);
          circles.delete(key);
        }
      }
      // Live transmission rings: pulse out to the site's tx (coverage) radius,
      // looping while the transmission is open. ttl expiry is the safety net.
      const expired: string[] = [];
      for (const [id, tx] of liveTx) {
        if (now >= tx.until) { expired.push(id); continue; }
        const txRadius = coverage.get(tx.key) ?? circles.get(tx.key)?.last?.radius ?? 7500 * geo;
        const t = ((now - tx.born) % PULSE_MS) / PULSE_MS;
        let ring = txRings.get(id);
        if (!ring) {
          ring = new google.maps.Circle({
            map, center: { lat: tx.lat, lng: tx.lng },
            strokeColor: tx.color, strokeWeight: 2, fillOpacity: 0, clickable: false, radius: 1,
          });
          txRings.set(id, ring);
        }
        ring.setOptions({ radius: Math.max(1, txRadius * t), strokeOpacity: 0.8 * (1 - t) });
      }
      for (const id of expired) endTx(id);
      // Quiet map: stop scheduling entirely so the WebGL compositor can deep-
      // idle (it shares the CPU/iGPU envelope with the DSP). wake() resumes.
      if (alive.length === 0 && liveTx.size === 0) { ticking = false; return; }
      if (liveTx.size) {
        // rAF gives the rings their smooth pulse — but it must NEVER be the SOLE
        // re-arm: if the compositor defers/drops the rAF (deep idle), a wall-clock
        // fallback still continues the loop, so `ticking` can't get stranded true
        // and freeze the map. `ran` guards against double-firing.
        let ran = false;
        const go = (): void => { if (ran) return; ran = true; tick(); };
        requestAnimationFrame(() => setTimeout(go, 40));
        setTimeout(go, 250);
      } else {
        // Blip decay alone is fine on a bare timer — rAF would just force a frame.
        setTimeout(tick, 150);
      }
    }
    wake();
  }
}

// Instrument-dark cartography to match the kiosk.
const DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1c1f26" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#747b8a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1c1f26" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2b303b" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#42454e" }] },
  // Roads stay as geometry for orientation, but their labels and highway
  // shields compete with the blips — the activity is the map's subject.
  { featureType: "road", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road.highway", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#13161c" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#262b34" }] },
];
