// Capture plain-NAC audio frames + plain-WFC rows from a FernSDR receiver,
// exactly as CbNet negotiates them, for test/fixtures/fernsdr. Read-only
// listener; never touches /admin.
//   node scripts/fernsdr-capture.mjs ws://192.168.1.30:8073/ws cb-radio 27185000 am out.json
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const [url, band, freq, mode, out] = process.argv.slice(2);
const MAX_AUDIO = 300, MAX_ROWS = 40;
const ws = new WebSocket(url);
const cap = { audioConfig: [], audio: [], rows: [] };
ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const m = JSON.parse(String(data));
    if (m.type === "welcome") {
      const caps = (m.capabilities ?? []).filter((c) => c === "audio-discontinuity");
      const b = m.bands.find((x) => x.id === band);
      ws.send(JSON.stringify({ type: "hello", capabilities: caps }));
      ws.send(JSON.stringify({ type: "audio", enabled: true, rate: 12000 }));
      ws.send(JSON.stringify({ type: "tune", band, freq: Number(freq), mode, request_id: 1 }));
      ws.send(JSON.stringify({ type: "viewport", enabled: true, low: b.low, high: b.high, width: 456, fps: 10 }));
    } else if (m.type === "audio-config") cap.audioConfig.push(m);
    return;
  }
  const buf = Buffer.from(data);
  if (buf[0] === 1 && cap.audio.length < MAX_AUDIO) cap.audio.push(buf.toString("base64"));
  if (buf[0] === 2 && cap.rows.length < MAX_ROWS) cap.rows.push(buf.toString("base64"));
  if (cap.audio.length >= MAX_AUDIO && cap.rows.length >= MAX_ROWS) {
    ws.close(1000);
    writeFileSync(out, JSON.stringify(cap));
    console.log(`wrote ${out}: ${cap.audio.length} audio, ${cap.rows.length} rows`);
  }
});
ws.on("error", (e) => { console.error(e.message); process.exit(1); });
