import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { probeStatus } from "../src/tunnel-probe.ts";

// Live, Nov 15: the Mac's DNS cache had looked up the new Cloudflare name before it existed and kept "no such host";
// the probe used that cache, called a working tunnel dead twice, and replaced it with one this network could not reach.
// The probe now resolves through the lookup it is given (public DNS in tunnel.ts), not the system cache.
test("the tunnel probe resolves the host through its own lookup, not the system resolver", async () => {
  const srv = createServer((_q, r) => { r.statusCode = 401; r.end(); }).listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  const port = (srv.address() as AddressInfo).port;
  const asked: string[] = [];
  const lookup = async (host: string) => { asked.push(host); return "127.0.0.1"; };
  try {
    // ".invalid" never resolves in real DNS, so only the given lookup can reach the server.
    assert.equal(await probeStatus(`http://tunnel.invalid:${port}/recall/events/`, lookup), 401);
    assert.deepEqual(asked, ["tunnel.invalid"]);
  } finally { srv.close(); }
});

test("a host nobody can resolve, or a closed port, reads as no answer (0)", async () => {
  assert.equal(await probeStatus("http://tunnel.invalid:9/recall/events/", async () => { throw new Error("ENOTFOUND"); }), 0);
  assert.equal(await probeStatus("http://tunnel.invalid:9/recall/events/", async () => "127.0.0.1"), 0);
});
