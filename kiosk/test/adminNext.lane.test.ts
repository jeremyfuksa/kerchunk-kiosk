// Enforces spec §2 / Ruling 10: every admin-next write goes through the
// poller's exclusive lane (`poller.run(...)`), because this appliance
// deadlocks on concurrent requests and a write racing a poll is exactly that.
//
// A textual heuristic, not a type check. For each admin-next/*.ts source it
// blanks comments, string literals and template-literal text (keeping ${…}
// expressions), then requires every `api.<write>(` call to sit inside the
// parentheses of some enclosing `.run(` call. Limits:
//   - it trusts any `.run(` (poller.run, the shell's io.run, …) — it can't tell
//     that the callee really is the poller's lane;
//   - a write reached indirectly (an api method passed by reference, or a
//     helper in another module that writes) is not seen;
//   - `.run(` must be on the call path textually: a write in a callback that
//     is merely *defined* inside run's arguments and called later passes;
//   - regex literals are not recognised; one with an unbalanced "(" would
//     confuse the paren stack (none exists today — the self-test guards the
//     scanner itself, the balance check below guards each file).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every api method that changes state on the appliance. */
const WRITES = [
  "putConfig", "setWeatherChannel", "skip", "setMode", "monitorStop", "setVolume", "setMuted",
  "dismissAlert", "clearAlerts", "monitor", "addChannel", "updateChannel", "deleteChannel",
  "testAlert", "reloadKiosk", "restartBackend", "powerAction", "deleteDiscoverySample",
];

/** Source with comments, string contents and template text blanked to spaces
 *  (same length, newlines kept), so only code is left to scan. */
export function codeOnly(src: string): string {
  const out = src.split("");
  const blank = (i: number): void => { if (out[i] !== "\n") out[i] = " "; };
  // Stack of contexts: "code" (with the brace depth it opened at) or "tpl".
  const stack: Array<{ kind: "code"; depth: number } | { kind: "tpl" }> = [{ kind: "code", depth: 0 }];
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1]!;
    const c = src[i]!;
    const n = src[i + 1];
    if (top.kind === "tpl") {
      if (c === "\\") { blank(i); blank(i + 1); i += 2; continue; }
      if (c === "`") { stack.pop(); i++; continue; }
      if (c === "$" && n === "{") { depth++; stack.push({ kind: "code", depth }); i += 2; continue; }
      blank(i); i++; continue;
    }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { blank(i); i++; } continue; }
    if (c === "/" && n === "*") {
      blank(i); blank(i + 1); i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { blank(i); i++; }
      blank(i); blank(i + 1); i += 2; continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") { blank(i); i++; }
        blank(i); i++;
      }
      i++; continue;
    }
    if (c === "`") { stack.push({ kind: "tpl" }); i++; continue; }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") {
      if (stack.length > 1 && top.depth === depth) stack.pop(); // closes a ${…}
      depth--; i++; continue;
    }
    i++;
  }
  return out.join("");
}

/** Writes not inside any `.run(`'s parentheses, as "api.x @ line N". Also
 *  reports an unbalanced paren stack (the heuristic would be unreliable). */
export function laneViolations(src: string): string[] {
  const code = codeOnly(src);
  const bad: string[] = [];
  const open: boolean[] = []; // per open "(": is it a `.run(`?
  const write = new RegExp(`^api\\.(${WRITES.join("|")})\\s*\\(`);
  const lineOf = (i: number): number => code.slice(0, i).split("\n").length;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(") { open.push(/\.run\s*$/.test(code.slice(Math.max(0, i - 12), i))); continue; }
    if (c === ")") { if (open.pop() === undefined) bad.push(`unbalanced ")" @ line ${lineOf(i)}`); continue; }
    if (c === "a" && !/[\w$.]/.test(code[i - 1] ?? "")) {
      const m = write.exec(code.slice(i, i + 40));
      if (m && !open.includes(true)) bad.push(`api.${m[1]} @ line ${lineOf(i)}`);
    }
  }
  if (open.length) bad.push(`${open.length} unclosed "("`);
  return bad;
}

describe("admin-next write lane", () => {
  it("the heuristic catches a bare write and accepts one inside .run(", () => {
    expect(laneViolations(`b.onclick = () => { void api.skip(); };`)).toEqual(["api.skip @ line 1"]);
    expect(laneViolations(`poller.run(() => api.skip()).catch(say);`)).toEqual([]);
    expect(laneViolations(`await poller.run(async () => {\n  const c = await api.getConfig();\n  await api.putConfig(c);\n});`)).toEqual([]);
    expect(laneViolations(`io.run(() => api.skip());\nawait api.setMuted(true);`)).toEqual(["api.setMuted @ line 2"]);
    // Reads are fine anywhere; lookalike names don't match.
    expect(laneViolations(`await api.getConfig(); await api.monitorStopped?.();`)).toEqual([]);
    expect(laneViolations(`poller.run(() => api.monitor(1)); api.monitorStop();`)).toEqual(["api.monitorStop @ line 1"]);
  });
  it("the heuristic ignores comments, strings and template text", () => {
    expect(laneViolations(`// api.skip()\n/* api.putConfig(x) */ const s = "api.skip()";`)).toEqual([]);
    expect(laneViolations("const t = `api.skip() ${a ? \"(\" : `)`}`;")).toEqual([]);
    expect(laneViolations("const t = `${ api.skip() }`;")).toEqual(["api.skip @ line 1"]);
  });

  const dir = join(import.meta.dirname, "../src/frontend/admin-next");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  it("finds the admin-next sources", () => {
    expect(files).toContain("radio.ts");
    expect(files).toContain("tune.ts");
    expect(files).toContain("shell.ts");
  });
  for (const f of files) {
    it(`${f}: every write goes through poller.run`, () => {
      expect(laneViolations(readFileSync(join(dir, f), "utf8"))).toEqual([]);
    });
  }
});
