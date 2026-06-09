# Channel De-duplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a frequency-uniqueness rule (GMRS/FRS exempt) that blocks new duplicate channels, audits existing ones, and resolves them on confirmed operator action.

**Architecture:** One pure module (`channelDedup.ts`) is the single source of the rule; three thin consumers sit on top — the `POST`/`PUT /api/channels` handlers (block with 409), a read-only `GET /api/channels/duplicates` audit endpoint, and a confirmed `POST /api/channels/duplicates/resolve` cleanup. The admin Channels page gains a Duplicates panel and surfaces the 409 inline.

**Tech Stack:** TypeScript (ESM, `.js` import extensions, `strict` + `noUncheckedIndexedAccess`), vitest + supertest, framework-free admin frontend. All commands from `kiosk/`.

---

## Background the engineer needs

- **Read [`CLAUDE.md`](../../../CLAUDE.md) first.** ESM with mandatory `.js` import extensions even from `.ts`; indexed access is `T | undefined`; run everything from `kiosk/`.
- **Spec:** [`docs/superpowers/specs/2026-06-09-channel-dedup-design.md`](../specs/2026-06-09-channel-dedup-design.md). The rule and guardrails there are binding.
- **`Channel` shape** ([`src/backend/config/schema.ts`](../../../kiosk/src/backend/config/schema.ts)): `{ id, freq, alphaTag, mode, enabled, audible?, priority?, alert?, rfDb?, levelTrimDb?, tags?, location? }`. `location` is `{ lat?, lon?, city?, state?, source? }`.
- **GMRS classification** is via `serviceFor(freqHz)` in [`src/backend/config/banks.ts`](../../../kiosk/src/backend/config/banks.ts) — returns `"GMRS/FRS"` for 462.5375–462.7375 and 467.5375–467.7375 MHz.
- **Channel CRUD handlers** live in [`src/backend/server.ts:628-657`](../../../kiosk/src/backend/server.ts#L628). `POST` builds `{ id: ch_<uuid>, ...parsed.data }` and calls `persistAndReload()`. `PUT` merges a partial. The plan inserts the collision check into these.
- **Server tests** use `supertest` + `FakeEngine` + a real `ConfigStore` in a tmpdir — see [`test/api.test.ts`](../../../kiosk/test/api.test.ts) `makeApp()`. Copy that harness.
- **Admin save path:** `saveRow(tr)` ([`admin.ts:778`](../../../kiosk/src/frontend/admin/admin.ts#L778)) already `catch`es and writes `(e as Error).message` to `chErr`. The `api` helper's `j<T>()` throws `Error("<status> <body>")` on non-ok, so a 409 already surfaces — the work is making the body text human-readable and adding the panel.

## File structure

- **Create** `kiosk/src/backend/config/channelDedup.ts` — pure rule: `isGmrs`, `collides`, `completeness`, `findDuplicateSets`. One responsibility.
- **Create** `kiosk/test/channelDedup.test.ts` — unit tests for the pure module.
- **Modify** `kiosk/src/backend/server.ts` — collision check in `POST`/`PUT`; two new endpoints (`GET`/`POST .../duplicates`).
- **Modify** `kiosk/test/api.test.ts` — handler tests for 409 + audit + resolve.
- **Modify** `kiosk/src/frontend/admin/admin.ts` — Duplicates panel + 409 message already flows via `chErr`.
- **Modify** `kiosk/src/frontend/admin/admin.css` — panel styling.

---

## Task 1: The pure rule module

**Files:**
- Create: `kiosk/src/backend/config/channelDedup.ts`
- Test: `kiosk/test/channelDedup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// kiosk/test/channelDedup.test.ts
import { describe, it, expect } from "vitest";
import { isGmrs, collides, completeness, findDuplicateSets } from "../src/backend/config/channelDedup.js";
import type { Channel } from "../src/backend/config/schema.js";

const ch = (over: Partial<Channel>): Channel => ({
  id: "ch_x", freq: 146_520_000, alphaTag: "T", mode: "nfm", enabled: true, ...over,
});

describe("isGmrs", () => {
  it("is true inside the GMRS allocation, false just outside", () => {
    expect(isGmrs(462_550_000)).toBe(true);
    expect(isGmrs(467_600_000)).toBe(true);
    expect(isGmrs(146_520_000)).toBe(false);
    expect(isGmrs(462_500_000)).toBe(false); // below the 462.5375 edge
  });
});

describe("collides", () => {
  it("two non-GMRS channels on the same freq collide", () => {
    expect(collides(ch({ id: "a" }), ch({ id: "b" }))).toBe(true);
  });
  it("different freqs do not collide", () => {
    expect(collides(ch({ id: "a", freq: 146_520_000 }), ch({ id: "b", freq: 146_550_000 }))).toBe(false);
  });
  it("two GMRS channels on the same freq do NOT collide (shared spectrum)", () => {
    expect(collides(ch({ id: "a", freq: 462_550_000 }), ch({ id: "b", freq: 462_550_000 }))).toBe(false);
  });
});

describe("completeness", () => {
  it("scores location highest, sums the other filled fields", () => {
    const bare = ch({});
    const rich = ch({
      location: { lat: 39, lon: -94 }, tags: ["ham"], priority: true, alert: true, rfDb: -40,
    });
    expect(completeness(bare)).toBe(0);
    expect(completeness(rich)).toBe(6); // 2 loc + 1 tags + 1 prio + 1 alert + 1 telemetry
  });
});

describe("findDuplicateSets", () => {
  it("returns only freqs with 2+ non-GMRS rows, richest first, GMRS excluded", () => {
    const a = ch({ id: "a", freq: 146_520_000 });                       // dup, bare
    const b = ch({ id: "b", freq: 146_520_000, location: { lat: 1, lon: 2 } }); // dup, richer
    const lone = ch({ id: "c", freq: 147_000_000 });                    // unique
    const g1 = ch({ id: "g1", freq: 462_550_000 });                     // GMRS dup — exempt
    const g2 = ch({ id: "g2", freq: 462_550_000 });
    const sets = findDuplicateSets([a, b, lone, g1, g2]);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.freq).toBe(146_520_000);
    expect(sets[0]!.channels.map((x) => x.channel.id)).toEqual(["b", "a"]); // richest first
  });

  it("breaks completeness ties by lowest id", () => {
    const z = ch({ id: "z", freq: 150_000_000 });
    const a = ch({ id: "a", freq: 150_000_000 });
    const sets = findDuplicateSets([z, a]);
    expect(sets[0]!.channels.map((x) => x.channel.id)).toEqual(["a", "z"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/channelDedup.test.ts`
Expected: FAIL — cannot resolve `../src/backend/config/channelDedup.js`.

- [ ] **Step 3: Implement the module**

```ts
// kiosk/src/backend/config/channelDedup.ts
// The single source of the frequency-uniqueness rule. Pure — no I/O.
// Two non-GMRS channels on one frequency are a duplicate; GMRS/FRS is shared
// channelized spectrum, so same-freq GMRS rows are legitimate and exempt.
import { serviceFor } from "./banks.js";
import type { Channel } from "./schema.js";

export interface DuplicateSet {
  freq: number;
  /** Rows on this freq, richest first (completeness desc, then id asc). */
  channels: Array<{ channel: Channel; completeness: number }>;
}

/** GMRS/FRS membership, derived from frequency (not tags). */
export function isGmrs(freqHz: number): boolean {
  return serviceFor(freqHz) === "GMRS/FRS";
}

/** Two channels collide: same freq and neither is GMRS. */
export function collides(a: Channel, b: Channel): boolean {
  return a.freq === b.freq && !isGmrs(a.freq) && !isGmrs(b.freq);
}

/** "Richest row" score — which row survives a cleanup. */
export function completeness(c: Channel): number {
  let s = 0;
  if (c.location?.lat !== undefined && c.location?.lon !== undefined) s += 2;
  if (c.tags && c.tags.length > 0) s += 1;
  if (c.priority === true) s += 1;
  if (c.alert === true) s += 1;
  if (c.levelTrimDb !== undefined || c.rfDb !== undefined) s += 1;
  return s;
}

/** Non-GMRS frequencies with 2+ rows, each set ranked richest-first. */
export function findDuplicateSets(channels: Channel[]): DuplicateSet[] {
  const byFreq = new Map<number, Channel[]>();
  for (const c of channels) {
    if (isGmrs(c.freq)) continue; // exempt — never a duplicate
    const list = byFreq.get(c.freq) ?? [];
    list.push(c);
    byFreq.set(c.freq, list);
  }
  const sets: DuplicateSet[] = [];
  for (const [freq, list] of byFreq) {
    if (list.length < 2) continue;
    const ranked = list
      .map((channel) => ({ channel, completeness: completeness(channel) }))
      .sort((x, y) => y.completeness - x.completeness || (x.channel.id < y.channel.id ? -1 : 1));
    sets.push({ freq, channels: ranked });
  }
  return sets.sort((a, b) => a.freq - b.freq);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/channelDedup.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/config/channelDedup.ts test/channelDedup.test.ts
git commit -m "feat(config): pure channel de-duplication rule (GMRS exempt)"
```

---

## Task 2: Block duplicates on add/edit (409)

**Files:**
- Modify: `kiosk/src/backend/server.ts` (the `POST` and `PUT /api/channels` handlers, ~lines 630-651)
- Test: `kiosk/test/api.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside the `describe("HTTP API", …)` block in `test/api.test.ts`)

```ts
  it("POST /api/channels rejects a duplicate non-GMRS frequency with 409", async () => {
    const { server } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "FIRST", mode: "nfm", enabled: true });
    const dup = await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "SECOND", mode: "nfm", enabled: true });
    expect(dup.status).toBe(409);
    expect(dup.body.conflictsWith.alphaTag).toBe("FIRST");
  });

  it("POST /api/channels ALLOWS a duplicate GMRS frequency", async () => {
    const { server } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 462550000, alphaTag: "GMRS-A", mode: "nfm", enabled: true });
    const dup = await request(server).post("/api/channels")
      .send({ freq: 462550000, alphaTag: "GMRS-B", mode: "nfm", enabled: true });
    expect(dup.status).toBe(201);
  });

  it("PUT /api/channels/:id rejects moving onto an occupied non-GMRS freq", async () => {
    const { server } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "A", mode: "nfm", enabled: true });
    const b = await request(server).post("/api/channels")
      .send({ freq: 147000000, alphaTag: "B", mode: "nfm", enabled: true });
    const moved = await request(server).put(`/api/channels/${b.body.id}`)
      .send({ freq: 146520000 });
    expect(moved.status).toBe(409);
  });

  it("PUT /api/channels/:id can edit a channel without colliding with itself", async () => {
    const { server } = makeApp();
    const a = await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "A", mode: "nfm", enabled: true });
    const edit = await request(server).put(`/api/channels/${a.body.id}`)
      .send({ alphaTag: "A2" });
    expect(edit.status).toBe(200);
    expect(edit.body.alphaTag).toBe("A2");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "duplicate"`
Expected: FAIL — duplicates currently return 201, not 409.

- [ ] **Step 3: Add the import** at the top of `server.ts` (near the other config imports)

```ts
import { collides, findDuplicateSets } from "./config/channelDedup.js";
```

- [ ] **Step 4: Insert the collision check in `POST /api/channels`**

In the `POST` handler (after the `safeParse` success check, before building `channel`), add:

```ts
      const conflict = config.channels.find((c) => collides(c, { ...parsed.data, id: "" }));
      if (conflict) return json(res, 409, {
        error: `frequency already used by ${conflict.alphaTag || conflict.freq}`,
        conflictsWith: { id: conflict.id, alphaTag: conflict.alphaTag },
      });
```

(`collides` only reads `freq`; the placeholder `id: ""` just satisfies the `Channel` type.)

- [ ] **Step 5: Insert the collision check in `PUT /api/channels/:id`**

In the `PUT` branch, after the `safeParse` success check and before the `config = …` map, add (the candidate freq is the patch's freq if present, else the existing row's):

```ts
        const existing = config.channels.find((c) => c.id === id)!;
        const candidate = { ...existing, ...parsed.data } as Channel;
        const conflict = config.channels.find((c) => c.id !== id && collides(c, candidate));
        if (conflict) return json(res, 409, {
          error: `frequency already used by ${conflict.alphaTag || conflict.freq}`,
          conflictsWith: { id: conflict.id, alphaTag: conflict.alphaTag },
        });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd kiosk && npx vitest run test/api.test.ts`
Expected: PASS — new 409 tests pass; the existing `POST adds a channel` / `restarts the scanner` tests still pass (their freqs are unique).

- [ ] **Step 7: Commit**

```bash
cd kiosk
git add src/backend/server.ts test/api.test.ts
git commit -m "feat(api): block duplicate non-GMRS frequencies on add/edit (409)"
```

---

## Task 3: Audit endpoint

**Files:**
- Modify: `kiosk/src/backend/server.ts` (add a `GET /api/channels/duplicates` route — place it BEFORE the `/^\/api\/channels\/([^/]+)$/` regex match so it isn't swallowed as an `:id`)
- Test: `kiosk/test/api.test.ts`

- [ ] **Step 1: Write the failing test** (append in the `describe`)

```ts
  it("GET /api/channels/duplicates lists non-GMRS duplicate sets, richest first", async () => {
    // The block rule (Task 2) stops NEW dupes via the API, so duplicates only
    // pre-exist in configs that predate the rule. Seed that state by writing
    // the config store directly, then read it back through a fresh server.
    const { configStore } = makeApp();
    const cfg = configStore.load();
    configStore.save({ ...cfg, channels: [
      { id: "a", freq: 146520000, alphaTag: "BARE", mode: "nfm", enabled: true },
      { id: "b", freq: 146520000, alphaTag: "RICH", mode: "nfm", enabled: true, location: { lat: 39, lon: -94 } },
      { id: "g1", freq: 462550000, alphaTag: "G1", mode: "nfm", enabled: true },
      { id: "g2", freq: 462550000, alphaTag: "G2", mode: "nfm", enabled: true },
    ] });
    // createServer reads the store at construction; build the server AFTER the seed.
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(100),
      wsHub: new WsHub(), staticDir: dir,
    });
    const res = await request(server).get("/api/channels/duplicates");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1); // GMRS pair excluded
    expect(res.body[0].freq).toBe(146520000);
    expect(res.body[0].channels[0].channel.id).toBe("b"); // richest first
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "duplicates lists"`
Expected: FAIL — 404 (route not defined).

- [ ] **Step 3: Add the route** in `server.ts`, immediately BEFORE the `const chMatch = /^\/api\/channels\/([^/]+)$/.exec(path);` line:

```ts
    if (method === "GET" && path === "/api/channels/duplicates") {
      return json(res, 200, findDuplicateSets(config.channels));
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "duplicates lists"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/server.ts test/api.test.ts
git commit -m "feat(api): GET /api/channels/duplicates audit endpoint"
```

---

## Task 4: Resolve (cleanup) endpoint

**Files:**
- Modify: `kiosk/src/backend/server.ts` (add `POST /api/channels/duplicates/resolve`, also before the `:id` regex)
- Test: `kiosk/test/api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("POST /api/channels/duplicates/resolve keeps the richest, deletes losers, spares GMRS", async () => {
    // Seed pre-existing dupes in the store, THEN build the server — createServer
    // snapshots config at construction (server.ts: `let config = configStore.load()`).
    const { configStore } = makeApp();
    const cfg = configStore.load();
    configStore.save({ ...cfg, channels: [
      { id: "a", freq: 146520000, alphaTag: "BARE", mode: "nfm", enabled: true },
      { id: "b", freq: 146520000, alphaTag: "RICH", mode: "nfm", enabled: true, location: { lat: 39, lon: -94 } },
      { id: "g1", freq: 462550000, alphaTag: "G1", mode: "nfm", enabled: true },
      { id: "g2", freq: 462550000, alphaTag: "G2", mode: "nfm", enabled: true },
    ] });
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(100),
      wsHub: new WsHub(), staticDir: dir,
    });
    const res = await request(server).post("/api/channels/duplicates/resolve");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 1, kept: 1 });
    const after = (await request(server).get("/api/channels")).body as Array<{ id: string }>;
    const ids = after.map((c) => c.id).sort();
    expect(ids).toEqual(["b", "g1", "g2"]); // bare "a" deleted; GMRS pair untouched
  });

  it("resolve is a no-op when there are no duplicates", async () => {
    const { server } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "ONLY", mode: "nfm", enabled: true });
    const res = await request(server).post("/api/channels/duplicates/resolve");
    expect(res.body).toEqual({ removed: 0, kept: 0 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "resolve"`
Expected: FAIL — 404.

- [ ] **Step 3: Add the route** in `server.ts`, just below the audit route from Task 3:

```ts
    if (method === "POST" && path === "/api/channels/duplicates/resolve") {
      const sets = findDuplicateSets(config.channels);
      // Losers = every row in each set except the richest (index 0).
      const remove = new Set<string>();
      for (const set of sets) for (const entry of set.channels.slice(1)) remove.add(entry.channel.id);
      if (remove.size > 0) {
        config = { ...config, channels: config.channels.filter((c) => !remove.has(c.id)) };
        await persistAndReload();
      }
      return json(res, 200, { removed: remove.size, kept: sets.length });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "resolve"`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/server.ts test/api.test.ts
git commit -m "feat(api): POST /api/channels/duplicates/resolve (keep richest, delete rest)"
```

---

## Task 5: Admin Duplicates panel + readable 409

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts`
- Modify: `kiosk/src/frontend/admin/admin.css`

No unit test (DOM glue; logic is tested in Tasks 1-4). Verified by build + manual check in Task 6.

- [ ] **Step 1: Confirm the 409 already surfaces** — no code change needed for the message path

`saveRow` ([admin.ts:778](../../../kiosk/src/frontend/admin/admin.ts#L778)) catches and writes `(e as Error).message` to `chErr`; the `api` helper throws `Error("409 {\"error\":\"frequency already used by …\"}")`. To make it clean, improve the helper's error to prefer the JSON `error` field. In `kiosk/src/frontend/lib/api.ts`, change `j<T>`:

```ts
async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    try { throw new Error((JSON.parse(text) as { error?: string }).error ?? text); }
    catch (e) { throw e instanceof Error && e.message ? e : new Error(`${res.status} ${text}`); }
  }
  return res.json() as Promise<T>;
}
```

(Now a 409 shows "frequency already used by FIRST" in `chErr`, not the raw status+JSON.)

- [ ] **Step 2: Add the panel container** to the Channels page markup

Find the channels page section in `admin.ts` (the block containing `id="chRows"` / the channel table). Immediately above the table element, insert:

```ts
      `<div id="dupPanel" class="dupPanel" hidden></div>` +
```

(Splice it into the existing template string for the channels page, before the `<table>` that holds `#chRows`.)

- [ ] **Step 3: Add the render function** near the other channels-page helpers in `admin.ts`

```ts
  // Duplicates audit (spec 2026-06-09): shown only when non-GMRS dupes exist.
  async function renderDuplicates(): Promise<void> {
    const panel = root.querySelector<HTMLElement>("#dupPanel");
    if (!panel) return;
    const sets = await fetch("/api/channels/duplicates").then((r) => (r.ok ? r.json() : [])) as Array<{
      freq: number; channels: Array<{ channel: { id: string; alphaTag: string }; completeness: number }>;
    }>;
    if (sets.length === 0) { panel.hidden = true; panel.innerHTML = ""; return; }
    const total = sets.reduce((n, s) => n + s.channels.length - 1, 0);
    panel.hidden = false;
    panel.innerHTML =
      `<h3>${sets.length} frequenc${sets.length === 1 ? "y has" : "ies have"} duplicate rows</h3>` +
      sets.map((s) => `<div class="dupSet"><strong>${fmtFreq(s.freq)}</strong><ul>` +
        s.channels.map((c, i) =>
          `<li>${esc(c.channel.alphaTag || "(unnamed)")}${i === 0 ? ' <span class="dupKeep">keeps</span>' : ' <span class="dupDrop">removed</span>'}</li>`,
        ).join("") + `</ul></div>`).join("") +
      `<button id="dupResolve" class="danger">Delete ${total} duplicate row${total === 1 ? "" : "s"}</button>`;
    panel.querySelector<HTMLButtonElement>("#dupResolve")?.addEventListener("click", async () => {
      if (!confirm(`Delete ${total} duplicate row${total === 1 ? "" : "s"}? GMRS frequencies are never affected. This cannot be undone.`)) return;
      await fetch("/api/channels/duplicates/resolve", { method: "POST" });
      await refresh();
      await renderDuplicates();
    });
  }
```

(`fmtFreq` and `esc` are already imported in `admin.ts` — confirm at the top; both come from `../lib/format.js`.)

- [ ] **Step 4: Call it after the channel list renders**

In the channels-page `refresh()` (or wherever `#chRows` is populated), add at the end:

```ts
    void renderDuplicates();
```

- [ ] **Step 5: Add panel styling** to `admin.css`

```css
/* Channel duplicates audit panel (spec 2026-06-09). */
.dupPanel { border: 1px solid var(--warning, #b8860b); border-radius: 8px; padding: 12px 14px; margin: 0 0 14px; background: rgba(184,134,11,0.08); }
.dupPanel h3 { margin: 0 0 8px; font-size: 14px; }
.dupSet { margin: 0 0 8px; font-size: 13px; }
.dupSet ul { margin: 4px 0 0; padding-left: 18px; }
.dupKeep { color: #4caf50; font-size: 11px; text-transform: uppercase; }
.dupDrop { color: #e07b3a; font-size: 11px; text-transform: uppercase; }
.dupPanel button.danger { margin-top: 6px; background: #7a2418; color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
```

- [ ] **Step 6: Build to typecheck**

Run: `cd kiosk && npm run build`
Expected: build succeeds. Fix any TS error per the compiler (no `any` silencing).

- [ ] **Step 7: Commit**

```bash
cd kiosk
git add src/frontend/admin/admin.ts src/frontend/admin/admin.css src/frontend/lib/api.ts
git commit -m "feat(admin): channel duplicates panel + readable conflict message"
```

---

## Task 6: Full verification

**Files:** none.

- [ ] **Step 1: Run the whole suite + build**

Run: `cd kiosk && npm test && npm run build`
Expected: all tests PASS (existing + `channelDedup` + the new api tests); build succeeds.

- [ ] **Step 2: Manual smoke (dev, no hardware)**

Run: `USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend` (terminal 1) + `npm run dev:frontend` (terminal 2). Open `/admin`, go to Channels. Verify:
  - Adding a channel on a freq already present (non-GMRS) shows "frequency already used by …" inline; the row is not added.
  - Adding two channels on a GMRS freq (e.g. 462.5500) both succeed.
  - With a config that has pre-existing dupes (hand-edit `/tmp/kc.json` to add two rows on one non-GMRS freq, restart backend), the Duplicates panel appears, marks the richer row "keeps," and the cleanup button (after confirm) removes the loser and hides the panel.

- [ ] **Step 3: Prove on the kiosk with the real config (per CLAUDE.md), then PR**

On the appliance: `git pull && (cd kiosk && npm run build) && sudo systemctl restart kerchunk-kiosk`, open `/admin` → Channels, and confirm the Duplicates panel reflects the **real** config (this is the audit's real payoff). Then:

```bash
git push -u origin feat/channel-dedup
gh pr create --title "feat: channel de-duplication (GMRS exempt)" --base main
```

---

## Out of scope (this plan)

- Merging field data between duplicate rows — survivor kept as-is, losers deleted.
- Uniqueness on mode/alphaTag — frequency is the key.
- Auto-running cleanup — always operator-initiated and confirmed.

## Success criteria (from the spec)

- Add/edit onto an occupied non-GMRS freq is rejected with a clear inline reason; GMRS never blocked.
- The Channels page shows a Duplicates panel iff dupes exist, marking each set's survivor.
- Confirmed cleanup removes exactly the non-survivor rows, leaving GMRS untouched.
- All rule logic covered by off-server unit tests; only the audit's real output needs the kiosk.
- `npm test` green; existing channel CRUD behavior preserved (unique freqs still add normally).
