import { describe, it, expect, vi } from "vitest";
import { RadioReference } from "../src/backend/radioreference.js";

const SOAP_HIT = `<?xml version="1.0"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
<SOAP-ENV:Body><ns1:searchCountyFreqResponse>
<return><item>
<out>464.275</out><in>469.275</in><callsign>WQAB123</callsign>
<descr>Worlds of Fun - Maintenance</descr><alpha>WOF Maint</alpha>
<tone>127.3 PL</tone><mode>FMN</mode>
</item></return>
</ns1:searchCountyFreqResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const SOAP_EMPTY = `<?xml version="1.0"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
<SOAP-ENV:Body><ns1:searchCountyFreqResponse><return></return>
</ns1:searchCountyFreqResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

function make(text: string, ok = true) {
  const fetcher = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 403, text: async () => text });
  const rr = new RadioReference({
    appKey: "k", username: "u", password: "p", countyIds: [1310, 1023], fetcher,
  });
  return { rr, fetcher };
}

const SOAP_ENTITIES = SOAP_HIT.replace(
  "<descr>Worlds of Fun - Maintenance</descr>",
  "<descr>Harrah&apos;s Kansas City (XPT) Site 001 &#8211; Casino</descr>",
).replace("<alpha>WOF Maint</alpha>", "<alpha></alpha>");

describe("RadioReference", () => {
  it("decodes XML entities in returned strings (&apos;, numeric refs)", async () => {
    const { rr } = make(SOAP_ENTITIES);
    const hit = await rr.lookup(464275000);
    expect(hit?.tag).toBe("Harrah's Kansas City (XPT) Site 001 – Casino · WQAB123");
  });

  it("finds a county frequency and prefers the RR alpha tag", async () => {
    const { rr, fetcher } = make(SOAP_HIT);
    const hit = await rr.lookup(464275000);
    expect(hit?.tag).toBe("WOF Maint · WQAB123");
    expect(hit?.mode).toBe("NFM"); // RR says FMN; normalized to our dialect
    // SOAP body carries auth + decimal MHz
    const body = fetcher.mock.calls[0][1].body as string;
    expect(body).toContain("<appKey>k</appKey>");
    expect(body).toContain("<freq>464.275</freq>");
  });

  it("returns null when no county knows the frequency", async () => {
    const { rr, fetcher } = make(SOAP_EMPTY);
    expect(await rr.lookup(462887500)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2); // tried both counties
  });

  it("degrades to null on HTTP/auth failure", async () => {
    const { rr } = make("denied", false);
    expect(await rr.lookup(464275000)).toBeNull();
  });

  it("does not negative-cache a transient failure — a later lookup retries", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" })
      .mockResolvedValue({ ok: true, status: 200, text: async () => SOAP_HIT });
    const rr = new RadioReference({
      appKey: "k", username: "u", password: "p", countyIds: [1310, 1023], fetcher,
    });
    expect(await rr.lookup(464275000)).toBeNull(); // both counties fail transiently
    const hit = await rr.lookup(464275000);        // retry — RR is back
    expect(hit?.tag).toBe("WOF Maint · WQAB123");
  });

  it("caches per county+freq — repeat lookup does not refetch", async () => {
    const { rr, fetcher } = make(SOAP_HIT);
    await rr.lookup(464275000);
    const n = fetcher.mock.calls.length;
    await rr.lookup(464275000);
    expect(fetcher.mock.calls.length).toBe(n);
  });
});
