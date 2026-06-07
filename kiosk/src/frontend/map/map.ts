import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import { BlipField, ringPoint, coverageRadiusM } from "./blips.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import icoTower from "lucide-static/icons/radio-tower.svg?raw";
import icoRadio from "lucide-static/icons/radio.svg?raw";
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

function colorFor(freqHz: number | undefined, kind: "active" | "closecall" | "nofix"): string {
  if (freqHz === undefined) return COLORS[kind];
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

function lucideMarker(svg: string, color: string, px: number): any {
  const colored = svg.replace(/currentColor/g, color).replace(/stroke-width="2"/, 'stroke-width="1.8"');
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(colored),
    scaledSize: new google.maps.Size(px, px),
    anchor: new google.maps.Point(px / 2, px / 2),
  };
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
      <span class="lgNote">blips &amp; pings wear their service's pin color · ring = no fix · glow = 30-day traffic · weather = live NEXRAD</span>
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

    // ── Auto-framing: the pins decide the view. Bounds collect the QTH,
    // the no-fix ring, every located channel, and every remembered site;
    // one fitBounds once the data lands. Config mapLat/Lon/Zoom is only
    // the pre-data first paint. The ring's 7 km radius doubles as a zoom
    // floor, so two close pins can't zoom the map into a parking lot.
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(home);
    // Framing is for the neighborhood: a corrupt row at (0,0) or a typo'd
    // site must not yank the view across an ocean. ~3° ≈ 300 km.
    function frame(lat: number, lon: number): void {
      if (Math.abs(lat - home.lat) < 3 && Math.abs(lon - home.lng) < 3) {
        bounds.extend({ lat, lng: lon });
      }
    }

    const field = new BlipField(BLIP_LIFETIME_MS);
    // site key -> rendered circle + label marker
    const circles = new Map<string, { circle: any; info: any }>();
    // Radar pings: short-lived expanding rings fired at each hit, so a key-up
    // is an EVENT on the map, not just a circle that exists.
    const PING_MS = 1600;
    const pings: Array<{ ring: any; born: number }> = [];

    function ping(lat: number, lon: number, color: string): void {
      pings.push({
        born: Date.now(),
        ring: new google.maps.Circle({
          map, center: { lat, lng: lon },
          radius: 400 * geo, strokeColor: color, strokeWeight: 2,
          strokeOpacity: 0.9, fillOpacity: 0, clickable: false,
        }),
      });
    }

    // ── Persistent antenna layer: any site heard at least once gets a small
    // mast icon that STAYS — the map remembers the RF neighborhood; live
    // pulses play on top of it.
    // Heat (ROADMAP Idea 8): each antenna carries a golden-amber glow disc
    // scaled by its 30-day hit count, so the busy corners of the band burn
    // visibly brighter. Log scale — site traffic spans 1..hundreds. (Not
    // Google's HeatmapLayer: deprecated May 2025, and per-site glow matches
    // the instrument aesthetic anyway.)
    const antennas = new Map<string, any>();
    const siteInfo = new google.maps.InfoWindow({ disableAutoPan: true });

    function heatFor(hits: number): { radius: number; opacity: number } {
      const h = Math.log2(1 + Math.max(0, hits));
      return {
        radius: Math.min(3000, 280 * (1 + h)),
        opacity: Math.min(0.18, 0.03 + 0.022 * h),
      };
    }

    function antenna(lat: number, lon: number, names: string[], hits: number, lastTs: number, increment = false): void {
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      const existing = antennas.get(key);
      if (existing) {
        existing.names = Array.from(new Set([...existing.names, ...names]));
        // Seeds carry cumulative store counts (merge = max); a live hit is
        // one MORE transmission (merge = increment) so glow grows tonight,
        // not just after the next reload.
        existing.hits = increment ? existing.hits + hits : Math.max(existing.hits, hits);
        existing.lastTs = Math.max(existing.lastTs, lastTs);
        const heat = heatFor(existing.hits);
        existing.glow.setOptions({ radius: heat.radius, fillOpacity: heat.opacity });
        return;
      }
      const heat = heatFor(hits);
      const glow = new google.maps.Circle({
        map, center: { lat, lng: lon },
        radius: heat.radius,
        strokeOpacity: 0, clickable: false,
        fillColor: "#ffc05c", fillOpacity: heat.opacity,
      });
      const pin = sitePin.get(key) ?? pinUnknown;
      const marker = new google.maps.Marker({
        map, position: { lat, lng: lon },
        icon: pinMarker(pin, Math.round(22 * mk)),
        title: names.join(", "),
      });
      const entry = { marker, glow, names: [...names], hits, lastTs };
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
    const channelsReady = fetch("/api/channels")
      .then((r) => (r.ok ? r.json() : []))
      .then((chs: Array<{ freq: number; location?: { lat?: number; lon?: number; powerWatts?: number; antennaHaatM?: number } }>) => {
        for (const c of chs) {
          if (c.location?.lat != null && c.location.lon != null) {
            frame(c.location.lat, c.location.lon);
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
          frame(sgt.lat, sgt.lon);
        }
      }))
      .catch(() => {});


    const COLORS = { active: "#ff6b35", closecall: "#dc3a38", nofix: "#4a7c7e" }; // spark / flamingo / pine

    // ── The unknown-origin ring (operator's pick): a dashed pine circle
    // around the QTH; activity we can't place pulses at a DETERMINISTIC
    // spot on it (hash of frequency), so GMRS 19 is always "its" dot —
    // identity without fake geography.
    const RING_M = 12_000;
    const ringPath: Array<{ lat: number; lng: number }> = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * 2 * Math.PI;
      ringPath.push({
        lat: home.lat + (RING_M * Math.cos(a)) / 111_320,
        lng: home.lng + (RING_M * Math.sin(a)) / (111_320 * Math.cos((home.lat * Math.PI) / 180)),
      });
    }
    for (const p of ringPath) bounds.extend(p);
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
        map.fitBounds(bounds, fitPad);
        // Remember the home zoom once the fit settles — the punch zoom and
        // the pull-back both reference it.
        google.maps.event.addListenerOnce(map, "idle", () => { homeZoom = map.getZoom(); });
      });

    // ── Activity camera (kiosk only): when a transmission opens, ease in
    // toward its site; when the band goes quiet, pull back out to the full
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
          map.fitBounds(bounds, fitPad);
        }
      }, 1500);
    }

    // ── Ambient auto-replay (ROADMAP Idea 3, the operator's premise note:
    // sparse traffic means live-decay visuals show an empty map — make
    // MEMORY beautiful instead). When the band stays quiet, the kiosk
    // replays the last hours of located traffic on a compressed loop,
    // honestly badged REPLAY; any live event snaps it off instantly.
    // Replay blips ping and steer the camera like live ones but never
    // touch the antenna/heat layers (those count real traffic only).
    const REPLAY_QUIET_MS = 120_000;   // band silence before replay starts
    const REPLAY_SPAN_MS = 3 * 3_600_000;   // how much history to replay
    const REPLAY_LOOP_MS = 90_000;     // 3 h compressed into 90 s
    let lastLiveTs = Date.now();
    let replayTimers: Array<ReturnType<typeof setTimeout>> = [];
    let replaying = false;
    const replayBadge = document.createElement("div");
    replayBadge.className = "replayBadge";
    replayBadge.textContent = "REPLAY — last 3 h";
    root.parentElement?.appendChild(replayBadge);

    function stopReplay(): void {
      if (!replaying) return;
      replaying = false;
      for (const t of replayTimers) clearTimeout(t);
      replayTimers = [];
      replayBadge.classList.remove("on");
    }

    async function startReplay(): Promise<void> {
      if (replaying || interactive) return;
      const rows = await fetch(`/api/history?since=${Date.now() - REPLAY_SPAN_MS}&limit=1000`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rs: Array<{ lat: number | null; lon: number | null; alphaTag: string; kind: string; ts: number; freq: number }>) =>
          rs.filter((r) => r.lat != null && r.lon != null && r.kind !== "alert").reverse())
        .catch(() => [] as never[]);
      if (rows.length < 3) return;   // nothing worth re-watching
      replaying = true;
      replayBadge.classList.add("on");
      const t0 = rows[0]!.ts;
      const span = Math.max(1, rows[rows.length - 1]!.ts - t0);
      const schedule = () => {
        if (!replaying) return;
        for (const r of rows) {
          const at = ((r.ts - t0) / span) * REPLAY_LOOP_MS;
          replayTimers.push(setTimeout(() => {
            if (!replaying) return;
            field.add({ lat: r.lat!, lon: r.lon!, alphaTag: r.alphaTag, kind: "active", ts: Date.now(), freq: r.freq });
            ping(r.lat!, r.lon!, colorFor(r.freq, "active"));
            punch(r.lat!, r.lon!);
          }, at));
        }
        replayTimers.push(setTimeout(() => { replayTimers = []; schedule(); }, REPLAY_LOOP_MS + 4000));
      };
      schedule();
    }

    if (!interactive) {
      setInterval(() => {
        if (!replaying && Date.now() - lastLiveTs > REPLAY_QUIET_MS) void startReplay();
      }, 5000);
    }
    new google.maps.Polyline({
      map, path: ringPath, clickable: false,
      strokeOpacity: 0,
      icons: [{
        icon: { path: "M 0,-1 0,1", strokeOpacity: 0.45, strokeColor: COLORS.nofix, scale: 2 },
        offset: "0", repeat: "14px",
      }],
    });
    new google.maps.Marker({
      map, position: ringPath[0], clickable: false,
      icon: { path: "M 0 0", scale: 0 } as any,
      label: { text: "NO FIX", color: "#4a7c7e", fontSize: interactive ? "11px" : "16px", fontFamily: "Barlow Condensed, sans-serif" },
    });

    // Persistent identity markers for heard-once unlocated channels (the
    // ring's parallel to the antenna layer — Lucide 'radio', dim pine).
    const ringIcon = lucideMarker(icoRadio, "#4a7c7e", Math.round(15 * mk));
    const ringMarks = new Map<number, any>();

    function nofix(freqHz: number, alphaTag: string, ts: number): void {
      const pos = ringPoint(home, RING_M, freqHz);
      field.add({ lat: pos.lat, lon: pos.lng, alphaTag, kind: "nofix", ts, freq: freqHz });
      if (Date.now() - ts < 2000) { ping(pos.lat, pos.lng, colorFor(freqHz, "nofix")); punch(pos.lat, pos.lng); }
      if (!ringMarks.has(freqHz)) {
        const marker = new google.maps.Marker({
          map, position: pos, icon: ringIcon,
          title: `${alphaTag} — origin unknown (ring position is symbolic)`,
        });
        ringMarks.set(freqHz, marker);
      }
    }

    function push(lat: number, lon: number, alphaTag: string, kind: "active" | "closecall", ts: number, freq?: number): void {
      field.add({ lat, lon, alphaTag, kind, ts, freq });
      // live hits ping and plant/refresh the persistent antenna
      if (Date.now() - ts < 2000) {
        ping(lat, lon, colorFor(freq, kind));
        antenna(lat, lon, [alphaTag], 1, ts, true);
        punch(lat, lon);
      }
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
      if (ev.type === "active" || ev.type === "closecall") {
        lastLiveTs = Date.now();
        stopReplay();
      }
      if (ev.type === "active") {
        if (ev.channel.location?.lat != null && ev.channel.location.lon != null) {
          push(ev.channel.location.lat, ev.channel.location.lon, ev.channel.alphaTag || fmtFreq(ev.freq), "active", Date.now(), ev.freq);
        } else {
          nofix(ev.freq, ev.channel.alphaTag || fmtFreq(ev.freq), Date.now());
        }
      } else if (ev.type === "closecall") {
        // discoveries are unlocated at the moment they fire (identification
        // is async) — they pulse on the ring; once enriched, future history
        // backfills place them properly.
        nofix(ev.freqHz, `Close Call ${fmtFreq(ev.freqHz)}`, Date.now());
      }
    }).connect();

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
        const col = colorFor(b.freq, b.kind);
        entry.circle.setOptions({
          // Power-rated sites blip at ESTIMATED COVERAGE (true geography, no
          // kiosk scale factor); the rest use the hit-count ramp.
          radius: coverage.get(key) ?? (3750 + 625 * Math.min(b.hits, 6)) * geo,
          strokeColor: col,
          strokeOpacity: Math.min(1, b.opacity * 1.4),
          fillColor: col,
          fillOpacity: 0.3 * b.opacity,
        });
      }
      for (const [key, entry] of circles) {
        if (!seen.has(key)) {
          entry.circle.setMap(null);
          circles.delete(key);
        }
      }
      // animate radar pings (fast: every frame they expand + fade)
      const now = Date.now();
      for (let i = pings.length - 1; i >= 0; i--) {
        const p = pings[i]!;
        const t = (now - p.born) / PING_MS;
        if (t >= 1) {
          p.ring.setMap(null);
          pings.splice(i, 1);
          continue;
        }
        p.ring.setOptions({ radius: (400 + 5200 * t) * geo, strokeOpacity: 0.9 * (1 - t) });
      }
      requestAnimationFrame(() => setTimeout(tick, pings.length ? 40 : 200));
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
  // Roads stay as geometry for orientation, but their labels and highway
  // shields compete with the blips — the activity is the map's subject.
  { featureType: "road", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road.highway", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#13161c" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#262b34" }] },
];
