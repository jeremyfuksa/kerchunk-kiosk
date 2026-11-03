import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import net from "node:net";
import request from "supertest";

// Linux refuses this double bind (EADDRINUSE), so it's only ever a Mac problem.
describe.runIf(process.platform === "darwin")("test servers on macOS", () => {
  it("reach the server under test when another app holds the same port on 127.0.0.1", async () => {
    const other = net.createServer((s) => { s.end("HTTP/1.1 405 Other\r\nContent-Length: 0\r\n\r\n"); });
    await new Promise<void>((resolve) => { other.listen(0, "127.0.0.1", resolve); });
    const { port } = other.address() as net.AddressInfo;
    const ours = createServer((_, res) => { res.end("ok"); });
    await new Promise<void>((resolve) => { ours.listen(port, resolve); });
    const res = await request(ours).get("/");
    ours.close();
    other.close();
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });
});
