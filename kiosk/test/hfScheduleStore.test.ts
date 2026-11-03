import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, readZip } from "../src/backend/hf/scheduleStore.js";

function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text, "latin1"));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(text.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const EIBI = "9395;0000-2400;;SVK;Radio Slovakia;E;ENA;/USA-o;1;;\r\n";
const AOKI = "title\r\nFRE   STATION                         UTC       Su-W-Sa Language             Pow Azi Location                ADM L/L             Remark\r\n11955 NHK WORLD RADIO JAPAN           0000-2400 1234567 Japanese             300 290 Ibaragi-Koga-Yamata     J   361024N1394923E NHK b26\r\n";
const HFCC = " 9395 0000 2400 3,4,9                          RMI  100 355       0 805 1234567 251026 280327 D       EngSpa     USA RMI FCC  1368\r\n";
const NOW = Date.UTC(2026, 10, 2, 12);
const home = { lat: 39, lon: -94 };
const routes = (): Record<string, () => Response> => ({
  "http://www.eibispace.de/dx/sked-b26.csv": () => new Response(EIBI),
  "http://www.eibispace.de/dx/README.TXT": () => new Response("   I) Language codes.\n   E     English: x\n"),
  "https://www1.s2.starcat.ne.jp/ndxc/nnk.htm": () => new Response('<a href="https://www1.m2.mediacat.ne.jp/x/xzb26.zip">B22</a><a href="old/xta26.zip">A26</a>'),
  "https://www1.m2.mediacat.ne.jp/x/xzb26.zip": () => new Response(new Uint8Array(zip({ "xzb26.txt": AOKI, "userlist1.txt": "no" }))),
  "https://hfcc.org/data/b26/b26allx2.zip": () => new Response(new Uint8Array(zip({ "B26all00.TXT": HFCC, "site.txt": "RMI Okeechobee                     USA 27N27 080W56\r\n" }))),
});

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function store(r = routes(), now = () => NOW) {
  dir = dir && existsSync(dir) ? dir : mkdtempSync(join(tmpdir(), "ksch-"));
  const calls: string[] = [];
  const s = new ScheduleStore({
    dir, home, now, log: () => {},
    fetch: (async (first: string, init?: RequestInit) => {
      // Follows redirects unless told not to, as the real fetch does.
      for (let url = first, hop = 0; hop < 20; hop++) {
        calls.push(url);
        const h = r[url];
        if (!h) return new Response("nope", { status: 404 });
        const res = h();
        const location = res.headers.get("location");
        if (init?.redirect === "manual" || !location) return res;
        url = new URL(location, url).href;
      }
      throw new Error("redirect loop");
    }) as unknown as typeof fetch,
  });
  return { s, calls };
}

describe("readZip", () => {
  it("reads deflated files by name", () => {
    expect(readZip(zip({ "a.txt": "hello", "b.txt": "there" })).get("b.txt")?.toString("latin1")).toBe("there");
  });
  it("gives nothing for something that isn't a zip", () => {
    expect(readZip(Buffer.from("not a zip")).size).toBe(0);
  });
});

describe("readZip limits", () => {
  it("refuses a file that inflates past the cap", () => {
    const big = zip({ "bomb.txt": "x".repeat(2_000_000) });
    expect(() => readZip(big, 1_000_000)).toThrow();
    expect(readZip(big, 3_000_000).get("bomb.txt")?.length).toBe(2_000_000);
  });
  it("counts the total across files", () => {
    expect(() => readZip(zip({ "a": "x".repeat(800_000), "b": "x".repeat(800_000) }), 1_000_000)).toThrow();
  });
});

describe("ScheduleStore", () => {
  beforeEachDir();
  function beforeEachDir() { dir = ""; }

  it("downloads all three sources and answers from them", async () => {
    const { s } = store();
    expect(s.candidates(9_395_000, NOW)).toEqual([]);
    await s.refresh();
    expect(s.candidates(9_395_000, NOW)[0]).toMatchObject({ station: "Radio Slovakia", language: "English", powerKw: 100, site: "Okeechobee" });
    expect(s.candidates(11_955_000, NOW)[0]?.station).toBe("NHK WORLD RADIO JAPAN");
  });

  it("finds the Aoki zip by file name, not its label", async () => {
    const { s, calls } = store();
    await s.refresh();
    expect(calls).toContain("https://www1.m2.mediacat.ne.jp/x/xzb26.zip");
    expect(calls.some((u) => u.includes("xta26"))).toBe(false);
  });

  it("won't follow an Aoki link off the known hosts", async () => {
    for (const bad of ["http://169.254.169.254/xzb26.zip", "https://evil.example/xzb26.zip", "https://www1.m2.mediacat.ne.jp.evil.example/xzb26.zip", "http://www1.m2.mediacat.ne.jp/xzb26.zip"]) {
      const r = routes();
      r["https://www1.s2.starcat.ne.jp/ndxc/nnk.htm"] = () => new Response(`<a href="${bad}">x</a>`);
      const { s, calls } = store(r);
      await s.refresh();
      expect(calls).not.toContain(bad);
    }
  });

  it("won't follow an Aoki redirect off the known hosts", async () => {
    for (const bad of ["http://169.254.169.254/xzb26.zip", "https://evil.example/xzb26.zip", "http://www1.m2.mediacat.ne.jp/xzb26.zip"]) {
      const r = routes();
      const fetched = () => new Response(new Uint8Array(zip({ "xzb26.txt": AOKI })));
      r["https://www1.m2.mediacat.ne.jp/x/xzb26.zip"] = () => new Response(null, { status: 302, headers: { location: bad } });
      r[bad] = fetched;
      const { s, calls } = store(r);
      await s.refresh();
      expect(calls).not.toContain(bad);
      expect(s.candidates(11_955_000, NOW)).toEqual([]);
    }
  });

  it("does follow an Aoki redirect that stays on the known hosts, relative or not", async () => {
    const r = routes();
    const zipped = r["https://www1.m2.mediacat.ne.jp/x/xzb26.zip"]!;
    r["https://www1.m2.mediacat.ne.jp/x/xzb26.zip"] = () => new Response(null, { status: 301, headers: { location: "/moved/xzb26.zip" } });
    r["https://www1.m2.mediacat.ne.jp/moved/xzb26.zip"] = () => new Response(null, { status: 302, headers: { location: "https://www1.s2.starcat.ne.jp/y/xzb26.zip" } });
    r["https://www1.s2.starcat.ne.jp/y/xzb26.zip"] = zipped;
    const { s } = store(r);
    await s.refresh();
    expect(s.candidates(11_955_000, NOW)[0]?.station).toBe("NHK WORLD RADIO JAPAN");
  });

  it("gives up on an Aoki redirect loop", async () => {
    const r = routes();
    r["https://www1.m2.mediacat.ne.jp/x/xzb26.zip"] = () => new Response(null, { status: 302, headers: { location: "https://www1.m2.mediacat.ne.jp/x/xzb26.zip" } });
    const { s, calls } = store(r);
    await s.refresh();
    expect(calls.filter((u) => u.endsWith("xzb26.zip")).length).toBeLessThan(10);
    expect(s.candidates(9_395_000, NOW)[0]?.station).toBe("Radio Slovakia");
  });

  it("refuses an oversized download and keeps what it had", async () => {
    const a = store();
    await a.s.refresh();
    const big = routes();
    big["http://www.eibispace.de/dx/sked-b26.csv"] = () => new Response("9395;0000-2400;;X;Huge;E;x;;1;;\n".repeat(1_000_000));
    const b = store(big);
    b.s.loadFromDisk();
    await b.s.refresh();
    expect(b.s.candidates(9_395_000, NOW)[0]?.station).toBe("Radio Slovakia");
  });

  it("survives a restart from disk, with no fetch", async () => {
    const a = store();
    await a.s.refresh();
    const b = store({});
    b.s.loadFromDisk();
    expect(b.s.candidates(9_395_000, NOW)[0]?.station).toBe("Radio Slovakia");
    expect(b.calls).toEqual([]);
  });

  it("keeps the last good copy when a fetch fails", async () => {
    const a = store();
    await a.s.refresh();
    const broken = routes();
    broken["http://www.eibispace.de/dx/sked-b26.csv"] = () => { throw new Error("certificate has expired"); };
    const b = store(broken);
    b.s.loadFromDisk();
    await b.s.refresh();
    expect(b.s.candidates(9_395_000, NOW)[0]?.station).toBe("Radio Slovakia");
    expect(readFileSync(join(dir, "eibi.csv"), "latin1")).toContain("Radio Slovakia");
  });

  it("keeps the last good copy when a download parses to nothing", async () => {
    const a = store();
    await a.s.refresh();
    const broken = routes();
    broken["http://www.eibispace.de/dx/sked-b26.csv"] = () => new Response("<html>maintenance</html>");
    const b = store(broken);
    b.s.loadFromDisk();
    await b.s.refresh();
    expect(b.s.candidates(9_395_000, NOW)[0]?.station).toBe("Radio Slovakia");
  });

  it("one source failing doesn't stop the others", async () => {
    const broken = routes();
    broken["https://www1.s2.starcat.ne.jp/ndxc/nnk.htm"] = () => new Response("nope", { status: 500 });
    const { s } = store(broken);
    await s.refresh();
    expect(s.candidates(9_395_000, NOW)[0]?.station).toBe("Radio Slovakia");
    expect(s.candidates(11_955_000, NOW)).toEqual([]);
  });

  it("is due when never fetched or a day old, and not otherwise", async () => {
    let t = NOW;
    const { s } = store(routes(), () => t);
    expect(s.due()).toBe(true);
    await s.refresh();
    expect(s.due()).toBe(false);
    t += 24 * 3_600_000;
    expect(s.due()).toBe(true);
  });

  it("a refresh where every source failed is retried within the hour, not tomorrow", async () => {
    let t = NOW;
    const { s } = store({}, () => t);
    await s.refresh();
    expect(s.due()).toBe(false);          // not hammering: a pause first
    t += 3_600_000;
    expect(s.due()).toBe(true);
    const fresh = store({}, () => t);
    expect(fresh.s.due()).toBe(true);     // and no stamp on disk to say otherwise
  });

  it("a README with no site table doesn't replace a good one", async () => {
    const a = store();
    await a.s.refresh();
    const r = routes();
    r["http://www.eibispace.de/dx/README.TXT"] = () => new Response("<html>maintenance</html>");
    const b = store(r);
    b.s.loadFromDisk();
    await b.s.refresh();
    expect(readFileSync(join(dir, "eibi-readme.txt"), "latin1")).toContain("Language codes");
  });

  it("a corrupt file on disk doesn't stop the boot", () => {
    dir = mkdtempSync(join(tmpdir(), "ksch-"));
    writeFileSync(join(dir, "eibi.csv"), "garbage");
    const { s } = store();
    expect(() => s.loadFromDisk()).not.toThrow();
    expect(s.candidates(9_395_000, NOW)).toEqual([]);
  });
});
