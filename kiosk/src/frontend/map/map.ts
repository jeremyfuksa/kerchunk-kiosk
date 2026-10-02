import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import { coverageRadiusM } from "./blips.js";
import { AircraftLayer } from "./aircraft.js";
import { GlassLayer } from "./glassLayer.js";
import { RadarSync, httpRadarFetchers } from "./radarSync.js";
import { GlassState, RELEASE_MS, type GlassSite } from "./glassState.js";
import { hexToGlowRgb } from "./glassMath.js";
import { padRect, outside, edgeExit, lngLatToViewPx, occluded, slideClear, BLOOM_PX, type Rect } from "./stage.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import icoTower from "lucide-static/icons/radio-tower.svg?raw";
import { PIN_COLORS, colorFor, categoryFor, type PinCategory } from "../lib/serviceColor.js";
// Operator-designed service pins (claude.ai/design handoff, 2026-06-07):
// cream teardrops with vivid service heads; Home is deliberately inverted
// (sea-glass ring, cream head) so the QTH reads as YOURS on the dark map.
import pinAir from "./pins/pin-air.svg?raw";
import pinRail from "./pins/pin-rail.svg?raw";
import pinHam from "./pins/pin-ham.svg?raw";
import pinGmrs from "./pins/pin-gmrs.svg?raw";
import pinBiz from "./pins/pin-biz.svg?raw";
import pinPublicSafety from "./pins/pin-publicsafety.svg?raw";
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
const PIN_SVG: Record<PinCategory, string> = {
  air: pinAir, rail: pinRail, ham: pinHam, gmrs: pinGmrs, biz: pinBiz,
  marine: pinMarine, weather: pinWeather, publicsafety: pinPublicSafety, unknown: pinUnknown,
};

// Pin for a site: an operator service tag (bank label) wins over the frequency
// allocation — so a conventional-UHF EMS/hospital channel filed in the Public
// Safety bank wears the red pin even though its frequency reads as "biz/PS".
// Heard-only sites and transient blips have no channel tags and fall back to
// frequency (see categoryFor).
function pinFor(freqHz: number, tags?: readonly string[]): string {
  return PIN_SVG[categoryFor(freqHz, tags)];
}

// Live activity map (ROADMAP Idea 2, Google Maps per operator decision):
// every channel opening / Close Call with a known transmitter site pulses on
// the map and decays over a minute. Backfills the last hour from /api/history
// so the picture is alive from first paint. Honest framing: a blip is the
// REPEATER/TRANSMITTER site, not the person talking.

const BLIP_LIFETIME_MS = 60_000;
// Safety cap if a `release` is ever missed; the audible channel re-arms it
// on every `signal`, so a continuous carrier doesn't expire mid-transmission.
const TX_TTL_MS = 60_000;
const HISTORY_BACKFILL_MS = 3_600_000;

declare const google: any; // loaded dynamically with the configured key
// The line above declares a VALUE, so `google.maps.X` in *type* position had
// nothing to resolve against — which is why `framedBounds()` below failed to
// compile the moment this file was first typechecked (issue #224). The Maps
// types are deliberately not vendored, so these alias to `any` exactly like
// the value does: the annotations document intent, they do not check it.
declare namespace google.maps {
  type LatLngBounds = any;
}

// The full-page /map view: the activity map plus its legend. The kiosk
// dashboard mounts the SAME map via mountActivityMap (map-as-stage), without
// the legend and without input affordances.
export function renderMap(root: HTMLElement): void {
  root.innerHTML = `<div class="mapWrap">
    <div id="gmap"></div>
    <div class="mapLegend">
      <span class="lgAnt"></span> Pins are sites by service · a grey ? is unclassified
      <span class="lgNote">Edge glow: activity with no known location · Weather: live NEXRAD (IEM)</span>
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
      backgroundColor: MAP_GROUND,
      ...(mapId
        // colorScheme keeps the base map dark even while the console style
        // is unassociated or still propagating — never a white flash.
        ? { mapId, isFractionalZoomEnabled: true, colorScheme: "DARK" }
        : { styles: DARK_STYLE }),
    });

    // Aircraft overlay layer: fed by "aircraft" WS snapshots below. Markers
    // snap on each poll (no per-frame animation), so this never wakes the blip
    // idle loop. The layer is inert until the first snapshot arrives.
    const aircraft = new AircraftLayer(map, geo, cfg.aircraft?.trails ?? false);


    // Edge glow: a hit with no honest map position has nowhere truthful to sit,
    // so instead of a synthetic dot we pulse the screen edges in the band's
    // color — "something on <service> just keyed up, location unknown".
    // The glow is a viewport-fixed overlay (see .edgeGlow), so it needs NO
    // positioning context on `root`. DON'T set root.style.position here: on the
    // kiosk `root` is #mapBase, whose fullscreen size comes from the
    // `.mapStage .mapBase { position: absolute; inset: 0 }` rule, and an inline
    // `position: relative` overrides that class rule (inline > class), collapsing
    // the container to zero height — a blank map in both vector and raster.
    const glow = document.createElement("div");
    glow.className = "edgeGlow";
    root.appendChild(glow);
    function glowEdges(color: string): void {
      glow.style.setProperty("--glow-color", color);
      glow.classList.remove("pulse");
      void glow.offsetWidth; // force reflow so the animation restarts every hit
      glow.classList.add("pulse");
    }
    // Off-frame speaker (spec 2026-10-02): a soft bloom on the screen edge
    // where the line from the frame's centre toward the site leaves the screen.
    // Opacity-only animation (compositor), 480 px — not a full-screen overlay.
    const bloom = document.createElement("div");
    bloom.className = "edgeBloom";
    root.appendChild(bloom);
    function bloomToward(lat: number, lng: number, color: string): boolean {
      const b = map.getBounds();
      if (!b) return false;
      const ne = b.getNorthEast(), sw = b.getSouthWest();
      const W = root.clientWidth, H = root.clientHeight;
      const p = lngLatToViewPx(lat, lng, { n: ne.lat(), s: sw.lat(), e: ne.lng(), w: sw.lng() }, W, H);
      const inner = padRect(W, H, KIOSK_FIT_PAD);
      // The clock and the corner (which grows into the glass LCD at exactly
      // this moment) hide pins the fit padding can't know about: measure them
      // live, once per audible event. A pin under one blooms; a bloom never
      // lands under one.
      const overlays: Rect[] = [...document.querySelectorAll(".kc-clock, .kc-corner")]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
      if (!outside(p, inner) && !occluded(p, overlays)) return false;
      const c = { x: (inner.left + inner.right) / 2, y: (inner.top + inner.bottom) / 2 };
      const view = { left: 0, top: 0, right: W, bottom: H };
      const at = slideClear(edgeExit(c, p, view), overlays, view, BLOOM_PX / 2);
      bloom.style.setProperty("--glow-color", color);
      bloom.style.transform = `translate(${Math.round(at.x - BLOOM_PX / 2)}px, ${Math.round(at.y - BLOOM_PX / 2)}px)`;
      bloom.classList.remove("pulse");
      void bloom.offsetWidth; // restart the animation every hit
      bloom.classList.add("pulse");
      return true;
    }

    // ── Weather Glass (spec 2026-10-01): one GPU layer inside Google's GL
    // context. Radar is IEM's real n0q composite, cropped by the backend
    // (/api/radar) and crossfaded between scans. Needs a vector map (Map ID).
    const display = cfg.display!;
    const glassState = new GlassState({
      growMs: display.glass.txGrowMs, releaseMs: RELEASE_MS,
      glowLifetimeMs: BLIP_LIFETIME_MS, ttlMs: TX_TTL_MS,
      holdFps: display.glass.holdFps, signalSteps: display.glass.signalSteps, fadeSteps: display.glass.fadeSteps,
    });
    const glass = mapId
      ? new GlassLayer({ map, home, knobs: display.glass, getFrame: (now) => glassState.frame(now) })
      : null;
    const poke = (): void => { if (glass && !glass.off) glass.poke(); };
    // How often the wall really redraws (spec 2026-10-02 proof): one journal
    // line every PACING_REPORT_MS on the kiosk.
    const PACING_REPORT_MS = 5 * 60_000;
    if (!interactive && glass) {
      setInterval(() => {
        if (glass.off) return;
        const perMin = glass.takeRedraws() / (PACING_REPORT_MS / 60_000);
        void fetch("/api/kiosk/diag", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "pacing", glassRedrawsPerMin: perMin }) })
          .catch(() => { /* best-effort */ });
      }, PACING_REPORT_MS);
    }
    const glassStatus = (): string => (glass ? glass.status : "off:no-mapid");
    const radarSync = glass && display.radar.enabled
      ? new RadarSync({
          ...httpRadarFetchers,
          onFrame: (f) => glass.setRadar(f),
          onStale: (stale) => glass.setRadarStale(stale),
          staleMs: display.radar.staleMs,
        })
      : null;
    // Polls stop feeding a layer that gave up (no WebGL2 / shader failure):
    // it is unmounted, so a 4.6 MB-scan download would be for nothing.
    const pollRadar = (): void => { if (radarSync && glass && !glass.off) void radarSync.poll(); };
    if (radarSync) {
      pollRadar();
      setInterval(pollRadar, display.radar.refreshMs);
      setInterval(() => { if (!glass?.off) radarSync.checkStale(); }, 30_000);
    }

    // Kiosk render diagnostic (one journal line per page load): which renderer
    // Google gave us -- VECTOR needs working WebGL, RASTER is its choppier
    // fallback -- and the display's real frame pacing, plus the glass layer's
    // status. Motion-smoothness work needs this, and the kiosk has no devtools.
    if (!interactive) reportRenderDiag(map, glassStatus);

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
    // still pops a live blip + an edge bloom toward it when it transmits; it just
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

    const liveCount = (): number => glassState.liveCount(); // open transmissions (re-fit deferral)
    // freq -> operator bank tags, learned from /api/channels. Lets the transient
    // blip layer (keyed only by frequency) honor the same operator service tag
    // the site pins do — a public-safety-tagged channel pulses red, not biz.
    const freqTags = new Map<number, readonly string[]>();
    const tagsFor = (freq?: number): readonly string[] | undefined =>
      freq == null ? undefined : freqTags.get(freq);
    let audibleId: string | null = null; // current speaker owner (drives ring re-arm)
    // Rendered footprint: power-rated sites use ESTIMATED COVERAGE (true
    // geography); the rest use the old blip hit ramp (kiosk-scaled).
    const siteRadius = (key: string, hits: number): number =>
      coverage.get(key) ?? (3750 + 625 * Math.min(Math.max(hits, 1), 6)) * geo;
    const glassSite = (lat: number, lng: number, freq: number | undefined, kind: "active" | "closecall"): GlassSite => ({
      key: `${lat.toFixed(5)},${lng.toFixed(5)}`, lat, lng,
      color: hexToGlowRgb(colorFor(freq, kind, tagsFor(freq))),
    });

    function startTx(id: string, lat: number, lng: number, freq: number | undefined, kind: "active" | "closecall"): void {
      const s = glassSite(lat, lng, freq, kind);
      glassState.keyUp(id, s, siteRadius(s.key, glassState.hits(s.key) + 1), Date.now());
      poke();
    }
    function endTx(id: string): void {
      glassState.release(id, Date.now());
      poke();
    }

    // ── Persistent antenna layer: any site heard at least once gets a small
    // mast icon that STAYS — the map remembers the RF neighborhood; live
    // pulses play on top of it. (The per-site "heat" glow disc was removed —
    // it wasn't reading as meaningful; revisit if a better heat idea lands.)
    const antennas = new Map<string, any>();
    const siteInfo = new google.maps.InfoWindow({ disableAutoPan: true });

    function antenna(lat: number, lon: number, names: string[], hits: number, lastTs: number, increment = false, freq?: number): void {
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      const existing = antennas.get(key);
      if (existing) {
        existing.names = Array.from(new Set([...existing.names, ...names]));
        // Seeds carry cumulative store counts (merge = max); a live hit is one
        // MORE transmission (merge = increment) — kept for the info-window count.
        existing.hits = increment ? existing.hits + hits : Math.max(existing.hits, hits);
        existing.lastTs = Math.max(existing.lastTs, lastTs);
        // Upgrade a stuck-gray pin in place once a classifiable frequency lands,
        // so an unknown site recolors live without a reload. Only ever gray ->
        // known: never overwrite a real service pin, never re-set to gray.
        if (existing.pin === pinUnknown && freq != null) {
          const better = sitePin.get(key) ?? pinFor(freq, tagsFor(freq));
          if (better !== pinUnknown) {
            existing.pin = better;
            existing.marker.setIcon(pinMarker(better, Math.round(19 * mk)));
          }
        }
        return;
      }
      // A located config channel seeds the pin by service; otherwise derive it
      // from the site's own heard frequency (history/live), so a heard biz site
      // with no config location still wears its service pin instead of gray.
      const pin = sitePin.get(key) ?? (freq != null ? pinFor(freq, tagsFor(freq)) : pinUnknown);
      const marker = new google.maps.Marker({
        map, position: { lat, lng: lon },
        icon: pinMarker(pin, Math.round(19 * mk)),
        title: names.join(", "),
      });
      const entry = { marker, names: [...names], hits, lastTs, pin };
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
      .then((chs: Array<{ freq: number; tags?: string[]; location?: { lat?: number; lon?: number; powerWatts?: number; antennaHaatM?: number } }>) => {
        for (const c of chs) {
          if (c.tags?.length) freqTags.set(c.freq, c.tags);
          if (c.location?.lat != null && c.location.lon != null) {
            knownPositions.push({ lat: c.location.lat, lng: c.location.lon });
            const key = `${c.location.lat.toFixed(5)},${c.location.lon.toFixed(5)}`;
            if (c.location.powerWatts) {
              coverage.set(key, coverageRadiusM(c.location.powerWatts, c.location.antennaHaatM));
            }
            if (!sitePin.has(key)) sitePin.set(key, pinFor(c.freq, c.tags));
          }
        }
      })
      .catch(() => {});

    // Seed from everything the store has ever located — AFTER the channel
    // fetch resolves, so each site already knows its service pin.
    const sitesReady = channelsReady.then(() => fetch("/api/history/sites")
      .then((r) => (r.ok ? r.json() : []))
      .then((sites: Array<{ lat: number; lon: number; hits: number; lastTs: number; names: string[]; freq?: number }>) => {
        for (const sgt of sites) {
          antenna(sgt.lat, sgt.lon, sgt.names, sgt.hits, sgt.lastTs, false, sgt.freq);
          knownPositions.push({ lat: sgt.lat, lng: sgt.lon });
        }
      }))
      .catch(() => {});


    // Wait for the map's first idle as well as the data: fitBounds against
    // a not-yet-laid-out viewport computes minimum zoom (the whole world).
    // Kiosk padding is asymmetric: the map runs under the clock + weather
    // (top-right) and the corner (bottom-left), so the fit keeps pins clear
    // of both — Cameron (northernmost) once hid behind a bar at uniform 56px.
    const fitPad = interactive ? 56 : KIOSK_FIT_PAD;
    const mapReady = new Promise<void>((resolve) =>
      google.maps.event.addListenerOnce(map, "idle", resolve));
    void Promise.allSettled([sitesReady, channelsReady, mapReady])
      .then(() => {
        map.fitBounds(framedBounds(), fitPad);
        // Remember the home zoom once the fit settles — the punch zoom and
        // the pull-back both reference it.
        google.maps.event.addListenerOnce(map, "idle", () => { homeZoom = map.getZoom(); });
      });

    // ── Camera (spec 2026-10-02 "fixed stage"): the kiosk frames once and
    // never moves on its own — each push made Google re-lay-out the vector map
    // on the CPU. Who/where is carried by the pin, the transmission, the LCD
    // and (off-frame) the edge bloom. display.camera.follow restores the old
    // push toward the audible site + pull-back. /map never moves itself.
    const follow = !interactive && display.camera.follow;
    const PUNCH_HOLD_MS = 12_000;   // follow mode: quiet time before pulling back out
    const PUNCH_ZOOM_IN = 2;        // follow mode: levels closer than the home framing
    let homeZoom: number | null = null;
    let punchedUntil = 0;
    function punch(lat: number, lng: number): void {
      if (!follow) return;
      punchedUntil = Date.now() + PUNCH_HOLD_MS;
      map.panTo({ lat, lng });
      map.setZoom(Math.min((homeZoom ?? map.getZoom()) + PUNCH_ZOOM_IN, 13));
    }
    if (follow) {
      setInterval(() => {
        if (punchedUntil && Date.now() >= punchedUntil) {
          punchedUntil = 0;
          map.fitBounds(framedBounds(), fitPad);
        }
      }, 1500);
    }
    // Fixed stage: re-fit only when the screen resizes (sites and channels load
    // once per page; a newly located site joins the frame on the next
    // kiosk/reload). Never mid-transmission: deferred to the next idle.
    let refitDue = false;
    function refit(): void {
      if (liveCount() > 0) { refitDue = true; return; }
      refitDue = false;
      map.fitBounds(framedBounds(), fitPad);
    }
    function onQuiet(): void { if (refitDue) refit(); }
    if (!interactive && !follow) {
      let t: ReturnType<typeof setTimeout> | undefined;
      window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(refit, 500); });
    }

    function nofix(freqHz: number): void {
      // No honest position to plot — pulse the screen edges in the band's color
      // (active service color, not the muted nofix gray) instead of a fake dot.
      glowEdges(colorFor(freqHz, "active", tagsFor(freqHz)));
    }

    function push(lat: number, lon: number, alphaTag: string, kind: "active" | "closecall", ts: number, freq?: number, live = false): void {
      // Live hits plant/refresh the persistent antenna; the front itself is
      // started by the WS handler (startTx). Backfilled rows seed afterglows.
      // An explicit flag, not the old "ts < 2 s ago" test: the newest backfill
      // rows are scaled to within 2 s of now and must still seed a glow.
      if (live) antenna(lat, lon, [alphaTag], 1, ts, true, freq);
      else {
        const s = glassSite(lat, lon, freq, kind);
        glassState.seedGlow(s, siteRadius(s.key, glassState.hits(s.key) + 1), ts, Date.now());
        poke();
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
      if (ev.type === "reload") { location.reload(); return; }
      if (ev.type === "active") {
        const ch = ev.channel;
        if (ch.tags?.length) freqTags.set(ev.freq, ch.tags); // learn tags live, pre-fetch
        if (ch.location?.lat != null && ch.location.lon != null) {
          push(ch.location.lat, ch.location.lon, ch.alphaTag || fmtFreq(ev.freq), "active", Date.now(), ev.freq, true);
          startTx(ch.id, ch.location.lat, ch.location.lon, ev.freq, "active");
        } else {
          // No location: edge-glow only — no synthetic dot, and no ring pulsing
          // at a made-up spot.
          nofix(ev.freq);
        }
      } else if (ev.type === "release") {
        endTx(ev.channelId); // transmission closed — stop its ring
      } else if (ev.type === "idle") {
        audibleId = null;
        glassState.releaseAll(Date.now()); poke(); // all closed
        onQuiet();
      } else if (ev.type === "signal") {
        // The audible channel's telemetry: re-arm its ttl (a continuous carrier
        // never expires mid-transmission) and step its rim brightness — at most
        // holdFps times a second, only when the quantised level moves.
        if (audibleId) {
          const now = Date.now();
          glassState.rearm(audibleId, now);
          if (glassState.signal(audibleId, ev.dbfs, now)) poke();
        }
      } else if (ev.type === "closecall") {
        // discoveries are unlocated at the moment they fire (identification is
        // async) — they pulse the edge glow; once enriched, future events and
        // history backfills place them on the map properly.
        nofix(ev.freqHz);
      } else if (ev.type === "audible") {
        // Camera follows AUDIO only in follow mode. On the fixed stage an
        // audible site outside the padded frame blooms the edge toward it.
        const ch = ev.channel;
        audibleId = ch?.id ?? null; // drives the signal-driven ring re-arm above
        if (ch?.location?.lat != null && ch.location.lon != null) {
          if (follow) punch(ch.location.lat, ch.location.lon);
          else if (!interactive) {
            // Measure after the dashboard's next paint: it applies .is-glass
            // (the corner's full LCD size) on its rAF-coalesced render.
            const { lat, lon } = ch.location, color = colorFor(ch.freq, "active", tagsFor(ch.freq));
            setTimeout(() => bloomToward(lat, lon, color), BLOOM_MEASURE_DELAY_MS);
          }
        }
      } else if (ev.type === "radar") {
        pollRadar(); // a new scan landed — fetch it once
      } else if (ev.type === "aircraft") {
        // Full snapshot each poll — reconcile the marker set. The aircraft
        // layer manages its own Google Maps markers, independent of the glass.
        aircraft.update(ev.targets);
      }
    }).connect();

  }
}

// Instrument-dark cartography to match the kiosk.
/** What Google paints under the tiles (before they load, while panning):
 *  --kc-map-land, pinned by test/mapStyle. */
export const MAP_GROUND = "#15191f";

/** Kiosk fitBounds padding (px). Google pads the pin's TIP, and a pin's head
 *  stands ~50 px above it: top 250 keeps a head clear of the clock + weather
 *  + date (~190 px); bottom clears the idle pill (~70 px + margin). A knob. */
export const KIOSK_FIT_PAD = { top: 250, left: 80, right: 80, bottom: 120 };

/** Off-frame bloom: wait this long after `audible` before measuring the clock
 *  and corner overlays, so the corner has grown into the glass LCD. */
const BLOOM_MEASURE_DELAY_MS = 150;

export const DARK_STYLE = [
  // The --kc-map-* tokens as hex (test/mapStyle pins them to tokens.css).
  { elementType: "geometry", stylers: [{ color: "#15191f" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#5d6672" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#15191f" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#232a31" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#2c343e" }] },
  // Roads stay as geometry for orientation, but their labels and highway
  // shields compete with the blips — the activity is the map's subject.
  { featureType: "road", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road.highway", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0c1113" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#232a31" }] },
];

// Measure DIAG_MS of rAF pacing once the map has settled, then POST it. The
// loop runs only for those 2 s (no standing rAF: thermal rule).
const DIAG_SETTLE_MS = 8000;
const DIAG_MS = 2000;
function reportRenderDiag(map: { getRenderingType?: () => string }, glassStatus: () => string): void {
  setTimeout(() => {
    const gaps: number[] = [];
    let last = 0;
    const t0 = performance.now();
    const step = (t: number): void => {
      if (last) gaps.push(t - last);
      last = t;
      if (t - t0 < DIAG_MS) { requestAnimationFrame(step); return; }
      if (!gaps.length) return;
      gaps.sort((a, b) => a - b);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const body = {
        renderingType: String(map.getRenderingType?.() ?? "UNKNOWN"),
        fps: Math.round((1000 / mean) * 10) / 10,
        p95Ms: Math.round((gaps[Math.floor(gaps.length * 0.95)] ?? mean) * 10) / 10,
        maxMs: Math.round((gaps[gaps.length - 1] ?? mean) * 10) / 10,
        glass: glassStatus(),
      };
      void fetch("/api/kiosk/diag", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .catch(() => { /* best-effort */ });
    };
    requestAnimationFrame(step);
  }, DIAG_SETTLE_MS);
}
