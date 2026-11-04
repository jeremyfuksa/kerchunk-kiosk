#!/usr/bin/env node
// Regenerates src/frontend/dashboard/world.svg, the Atlas's land, from Natural Earth (public domain).
// Run by hand only if the map's centre or framing changes (both live in dashboard/miller.ts); the wall
// loads the committed SVG, so the kiosk has no d3 dependency.
//
//   curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
//   npm install --no-save --no-package-lock d3-geo d3-geo-projection
//   node scripts/gen-atlas-land.mjs ne_50m_admin_0_countries.geojson > src/frontend/dashboard/world.svg
//
// ISO_A2_EH, not ISO_A2: Natural Earth's ISO_A2 is -99 for France and Norway.
import { readFileSync } from "node:fs";
import { geoPath } from "d3-geo";
import { geoMiller } from "d3-geo-projection";

const CENTER_LON = -94.5, MAP_W = 1800, MAP_H = 1012, EQUATOR_Y = 527;   // keep in step with miller.ts

const projection = geoMiller().rotate([-CENTER_LON, 0]).scale(MAP_W / (2 * Math.PI)).translate([MAP_W / 2, EQUATOR_Y]).precision(0.5);

// Draws to a string, dropping points closer than MIN_STEP to the last one kept: about a pixel on the wall,
// and 1:50m has far more detail than that. A ring keeps at least its first point and its close.
const MIN_STEP = 1.5;
function outline(feature) {
  let d = "", last = null;
  const at = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  geoPath(projection, {
    moveTo(x, y) { d += `M${at(x, y)}`; last = [x, y]; },
    lineTo(x, y) {
      if (Math.hypot(x - last[0], y - last[1]) < MIN_STEP) return;
      d += `L${at(x, y)}`; last = [x, y];
    },
    closePath() { d += "Z"; },
    beginPath() {},
    arc() {},
  })(feature);
  return d;
}
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const shapes = JSON.parse(readFileSync(process.argv[2], "utf8")).features.map((f) => {
  const iso = f.properties.ISO_A2_EH;
  const id = /^[A-Z]{2}$/.test(iso) ? ` id="${iso}"` : "";
  return `<path${id} data-name="${esc(f.properties.NAME)}" d="${outline(f)}"/>`;
});
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_W} ${MAP_H}">\n<!-- Natural Earth 1:50m, public domain. See scripts/gen-atlas-land.mjs. -->\n${shapes.join("\n")}\n</svg>\n`);
