// Supertest gives a server a new ephemeral port for each request. With keep-alive on, a request whose port the OS
// has reused can land on a stale socket to an earlier test's server, which answers with its own 401 or 405.
import http from "node:http";

http.globalAgent = new http.Agent({ keepAlive: false });
