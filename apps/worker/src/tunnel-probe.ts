/**
 * Is the events tunnel forwarding? (scripts/tunnel.ts) Live, Nov 15: this Mac's DNS cache had asked for a new Cloudflare
 * name before it was published and kept "no such host" for minutes, so a probe through the system resolver called a working
 * tunnel dead and replaced it. The probe resolves the name through a lookup it is given: public DNS in tunnel.ts, the
 * same answer Recall's servers get.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Resolver } from "node:dns/promises";
import type { LookupFunction } from "node:net";

export type Lookup = (host: string) => Promise<string>;

/** IPv4 address of `host` from Cloudflare's and Google's public DNS, skipping the system cache. */
export function publicLookup(servers = ["1.1.1.1", "8.8.8.8"]): Lookup {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  r.setServers(servers);
  return async (host) => (await r.resolve4(host))[0];
}

/** HTTP status of a tokenless POST to `url` (the events server answers 401), or 0 for no answer. */
export function probeStatus(url: string, lookup: Lookup, timeoutMs = 8000): Promise<number> {
  const u = new URL(url);
  const nodeLookup = ((host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    lookup(host).then((address) => (opts?.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)), (e) => cb(e));
  }) as unknown as LookupFunction;
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done) => {
    const req = send(u, { method: "POST", lookup: nodeLookup, timeout: timeoutMs }, (res) => { res.resume(); done(res.statusCode ?? 0); });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(0));
    req.end();
  });
}
