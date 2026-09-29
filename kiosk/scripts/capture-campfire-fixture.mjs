// One-shot provenance script (chore/kerchunk-tokens, 2026-09-28): resolve every
// Campfire custom property the frontend references, under `.dark` (index.html
// sets <html class="dark">), from the INSTALLED package — which carries the
// night-ramp overlay (campfire#59), i.e. what the wall shows today.
// Output: test/fixtures/campfire-dark-resolved.json. Re-running after Campfire
// is uninstalled is impossible by design; the fixture is the record.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync("node_modules/@jeremyfuksa/campfire/dist/tokens.css", "utf8");
function block(sel) {
  const i = css.indexOf(`${sel} {`);
  const j = css.indexOf("}", i);
  const out = {};
  for (const m of css.slice(i, j).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const props = { ...block(":root"), ...block(".dark") };
const resolve = (v, depth = 0) =>
  depth > 10 ? v : v.replace(/var\((--[\w-]+)\)/g, (_, n) => resolve(props[n] ?? `var(${n})`, depth + 1));

function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(css|ts)$/.test(f)) acc.push(readFileSync(p, "utf8"));
  }
  return acc;
}
const used = new Set();
for (const src of walk("src/frontend")) for (const m of src.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]);

const out = {};
for (const name of [...used].sort()) if (props[name] !== undefined) out[name] = resolve(props[name]);
writeFileSync("test/fixtures/campfire-dark-resolved.json", JSON.stringify(out, null, 2) + "\n");
console.log(`${Object.keys(out).length} properties captured`);
