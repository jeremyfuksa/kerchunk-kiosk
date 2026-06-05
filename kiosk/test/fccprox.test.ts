import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FccProx } from "../src/backend/fccprox.js";

// Canned responses modeled on live probes (2026-06-05).
const PROX_XML = `<SOAP-ENV:Envelope><SOAP-ENV:Body><return>
<item xsi:type="tns:proxCallsignResult"><callsign xsi:type="xsd:string">KUT966</callsign><licensee xsi:type="xsd:string">CEDAR FAIR LP DBA WORLDS OF FUN</licensee><lat xsi:type="xsd:decimal">39.1764</lat><lon xsi:type="xsd:decimal">-94.4911</lon><distance xsi:type="xsd:decimal">0.27</distance></item>
<item xsi:type="tns:proxCallsignResult"><callsign xsi:type="xsd:string">WQZQ269</callsign><licensee xsi:type="xsd:string">HALLMARK RETAIL LLC</licensee><lat xsi:type="xsd:decimal">39.1711</lat><lon xsi:type="xsd:decimal">-94.4783</lon><distance xsi:type="xsd:decimal">0.52</distance></item>
</return></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const CALLSIGN_XML = `<SOAP-ENV:Envelope><SOAP-ENV:Body><return xsi:type="tns:fccCallsignDetails">
<licensee xsi:type="xsd:string">CEDAR FAIR LP DBA WORLDS OF FUN</licensee><callsign xsi:type="xsd:string">KUT966</callsign><status xsi:type="xsd:string">A</status>
<locations><item xsi:type="tns:fccLocation"><locationNumber xsi:type="xsd:int">1</locationNumber><antennaHeight xsi:type="xsd:decimal">15.0</antennaHeight><lat xsi:type="xsd:decimal">39.176388888889</lat><lon xsi:type="xsd:decimal">-94.491055555556</lon><city xsi:type="xsd:string">KANSAS CITY</city><state xsi:type="xsd:string">MO</state></item><item xsi:type="tns:fccLocation"><locationNumber xsi:type="xsd:int">2</locationNumber><lat xsi:type="xsd:decimal">40.0789</lat><lon xsi:type="xsd:decimal">-93.6147</lon><city xsi:type="xsd:string">TRENTON</city><state xsi:type="xsd:string">MO</state></item></locations>
<frequencies><item xsi:type="tns:fccFrequency"><locationNumber xsi:type="xsd:int">1</locationNumber><frequency xsi:type="xsd:decimal">463.42500000</frequency><emission xsi:type="xsd:string">11K0F3E</emission><power xsi:type="xsd:decimal">110.000</power></item></frequencies>
</return></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

function make() {
  const fetcher = vi.fn(async (_url: string, init: { body: string }) => ({
    ok: true,
    status: 200,
    text: async () => (init.body.includes("fccGetProxCallsigns") ? PROX_XML : CALLSIGN_XML),
  }));
  const g = new FccProx({
    appKey: "k", username: "u", password: "p",
    home: { lat: 39.2915, lon: -94.4953 },
    cacheDir: mkdtempSync(join(tmpdir(), "fcc-")),
    fetcher,
  });
  return { g, fetcher };
}

describe("FccProx", () => {
  it("name-gates licensees, frequency-confirms, returns the license site", async () => {
    const { g } = make();
    const hit = await g.lookup(463425000, { name: "Worlds of Fun Security" });
    expect(hit?.tag).toBe("Worlds of Fun Security"); // FCC donates geography, not names
    expect(hit?.location).toMatchObject({
      lat: 39.176388888889, lon: -94.491055555556,
      city: "Kansas City", state: "MO", source: "fcc",
    });
  });

  it("a name match WITHOUT a frequency grant is rejected", async () => {
    const { g } = make();
    // Worlds of Fun licensee matches by name, but 464.550 isn't on KUT966.
    expect(await g.lookup(464550000, { name: "Worlds of Fun Security" })).toBeNull();
  });

  it("no hint or no significant tokens = no lookup at all", async () => {
    const { g, fetcher } = make();
    expect(await g.lookup(463425000)).toBeNull();
    expect(await g.lookup(463425000, { name: "Ops 2" })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("probes a 19-point grid once, then serves from cache", async () => {
    const { g, fetcher } = make();
    await g.lookup(463425000, { name: "Worlds of Fun Security" });
    const probes = fetcher.mock.calls.filter((c) => c[1].body.includes("fccGetProxCallsigns")).length;
    expect(probes).toBe(19); // home + 6 inner hex + 12 outer ring
    await g.lookup(463425000, { name: "Hallmark Retail" });
    const probesAfter = fetcher.mock.calls.filter((c) => c[1].body.includes("fccGetProxCallsigns")).length;
    expect(probesAfter).toBe(19); // index reused
  });

  it("captures power for coverage blips; far-flung system-license sites are rejected", async () => {
    const { g } = make();
    const hit = await g.lookup(463425000, { name: "Worlds of Fun Security" });
    expect(hit?.location?.powerWatts).toBe(110);
    expect(hit?.location?.antennaHaatM).toBe(15);
  });
});
