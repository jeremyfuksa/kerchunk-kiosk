// Fetches the schedules at runtime, keeps the last good copy of each, and answers from what it has.
// Nothing here goes in the repo: Aoki and HFCC state no terms for redistribution.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseAoki, parseEibi, parseEibiReadme, parseHfcc, parseHfccSites, ScheduleDb, seasonCode } from "./schedule.js";
import type { Candidate } from "./receptionLog.js";

const REFRESH_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;       // after a refresh that got nothing
const FETCH_TIMEOUT_MS = 60_000;
const AOKI_INDEX = "https://www1.s2.starcat.ne.jp/ndxc/nnk.htm";
// The index names the zip's host, which changes, so a link is only followed to these.
const AOKI_HOSTS = /^[a-z0-9.-]+\.(starcat|mediacat)\.ne\.jp$/;
const MAX_REDIRECTS = 5;
// The real files are about 1 MB zipped and 1 MB inside. These caps are generous for that, and
// stop a bad or spoofed response from filling memory. EiBi has to come over plain HTTP.
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

/** The few fields of a zip this needs. Node has no zip reader, and these files are simple. */
export function readZip(zip: Buffer, maxBytes = MAX_INFLATED_BYTES): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let total = 0;
  let end = -1;
  for (let i = zip.length - 22; i >= 0 && end < 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) end = i;
  if (end < 0) return out;
  let p = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0 && p + 46 <= zip.length && zip.readUInt32LE(p) === 0x02014b50; n--) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("latin1", p + 46, p + 46 + nameLen);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body, { maxOutputLength: maxBytes - total }) : Buffer.from(body);
    total += data.length;
    if (total > maxBytes) throw new Error("zip too large");
    out.set(name, data);
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
}

export interface ScheduleStoreDeps {
  dir: string;
  home: { lat: number; lon: number };
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export class ScheduleStore {
  private db: ScheduleDb | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private lastAttempt = 0;

  constructor(private readonly deps: ScheduleStoreDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((m) => console.log(`[schedule] ${m}`));
    mkdirSync(deps.dir, { recursive: true });
  }

  candidates(hz: number, ts: number): Candidate[] { return this.db?.candidates(hz, ts) ?? []; }

  due(): boolean {
    if (this.lastAttempt && this.now() - this.lastAttempt < RETRY_MS) return false;
    const stamp = join(this.deps.dir, "fetched");
    if (!existsSync(stamp)) return true;
    return !(this.now() - new Date(readFileSync(stamp, "latin1")).getTime() < REFRESH_MS);
  }

  loadFromDisk(): void {
    const read = (f: string): string => {
      const p = join(this.deps.dir, f);
      return existsSync(p) ? readFileSync(p, "latin1") : "";
    };
    this.db = new ScheduleDb({
      eibi: parseEibi(read("eibi.csv")), readme: parseEibiReadme(read("eibi-readme.txt")),
      aoki: parseAoki(read("aoki.txt")), hfcc: parseHfcc(read("hfcc.txt")), hfccSites: parseHfccSites(read("hfcc-sites.txt")),
      home: this.deps.home,
    });
  }

  /** One after another, never in parallel. A source that fails keeps its last good copy. */
  async refresh(): Promise<void> {
    this.lastAttempt = this.now();
    const season = seasonCode(new Date(this.now()));
    const got = await Promise.resolve().then(async () => [await this.source("EiBi", async () => {
      const csv = await this.text(`http://www.eibispace.de/dx/sked-${season}.csv`);
      if (parseEibi(csv).length === 0) throw new Error("no rows");
      this.save("eibi.csv", csv);
      const readme = await this.text("http://www.eibispace.de/dx/README.TXT");
      if (parseEibiReadme(readme).languages.size > 0) this.save("eibi-readme.txt", readme);
    }), await this.source("Aoki", async () => {
      const page = (await this.aokiBytes(new URL(AOKI_INDEX))).toString("latin1");
      // The page's labels are wrong and the path changes each season. Only the file name is reliable.
      const href = new RegExp(`href="([^"]*\\b[a-z]{2}${season}\\.zip)"`, "i").exec(page)?.[1];
      if (!href) throw new Error(`no ${season} zip on the index`);
      const files = readZip(await this.aokiBytes(new URL(href, AOKI_INDEX)));
      const name = [...files.keys()].find((n) => new RegExp(`${season}\\.txt$`, "i").test(n));
      const text = name ? files.get(name)!.toString("latin1") : "";
      if (parseAoki(text).length === 0) throw new Error("no rows");
      this.save("aoki.txt", text);
    }), await this.source("HFCC", async () => {
      const files = readZip(await this.bytes(`https://hfcc.org/data/${season}/${season}allx2.zip`));
      const name = [...files.keys()].find((n) => /all00\.txt$/i.test(n));
      const text = name ? files.get(name)!.toString("latin1") : "";
      if (parseHfcc(text).length === 0) throw new Error("no rows");
      this.save("hfcc.txt", text);
      const sites = [...files.entries()].find(([n]) => /^site\.txt$/i.test(n))?.[1];
      if (sites) this.save("hfcc-sites.txt", sites.toString("latin1"));
    })]);
    if (!got.some(Boolean)) return;   // nothing new: no stamp, so it's tried again within the hour
    this.save("fetched", new Date(this.now()).toISOString());
    this.loadFromDisk();
  }

  private async source(name: string, get: () => Promise<void>): Promise<boolean> {
    try { await get(); this.log(`${name} updated`); return true; }
    catch (e) { this.log(`${name} fetch failed, keeping the last copy: ${(e as Error).message}`); return false; }
  }

  private async response(url: string): Promise<Response> {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": "kerchunk-kiosk" } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  }
  private async bytes(url: string): Promise<Buffer> { return this.read(url, await this.response(url)); }
  /** Every hop has to stay on Aoki's hosts: fetch would follow a redirect anywhere. */
  private async aokiBytes(first: URL): Promise<Buffer> {
    let url = first;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "https:" || !AOKI_HOSTS.test(url.hostname)) throw new Error(`refusing ${url.href}`);
      const res = await this.fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": "kerchunk-kiosk" } });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) { url = new URL(location, url); continue; }
      if (!res.ok) throw new Error(`${url.href}: HTTP ${res.status}`);
      return this.read(url.href, res);
    }
    throw new Error(`${first.href}: too many redirects`);
  }
  private async read(url: string, res: Response): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error(`${url}: too large`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  private async text(url: string): Promise<string> { return (await this.bytes(url)).toString("latin1"); }

  private save(name: string, text: string): void {
    const p = join(this.deps.dir, name);
    writeFileSync(`${p}.tmp`, text, "latin1");
    renameSync(`${p}.tmp`, p);
  }
}
