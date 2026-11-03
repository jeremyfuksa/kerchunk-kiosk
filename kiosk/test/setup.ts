// Supertest listens on the IPv6 wildcard, then connects to 127.0.0.1. macOS lets that port number also be held by any
// other process's 127.0.0.1 listener, which then gets the request: tests here have seen other apps' 400, 401 and 405.
// Connecting over ::1 can only reach the wildcard. Linux refuses the double bind, so it needs none of this.
import { createRequire } from "node:module";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

if (process.platform === "darwin") {
  const Test = createRequire(import.meta.url)("supertest/lib/test.js") as {
    prototype: { serverAddress(this: { _server?: Server }, app: Server, path: string): string };
  };
  Test.prototype.serverAddress = function (app, path) {
    if (!app.address()) this._server = app.listen(0);
    return `http://[::1]:${(app.address() as AddressInfo).port}${path}`;
  };
}
