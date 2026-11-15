/**
 * Live, Nov 15: the Mac changed networks mid-session and the MongoDB driver threw a PoolClearedOnNetworkError outside any
 * await; the worker exited and Gomon went silent. A lost connection to Atlas is not a bug: the driver reconnects by itself,
 * and every loop already logs and retries its own failed reads. Those errors are logged and the worker keeps running;
 * anything else still ends it, as before.
 */
import { MongoNetworkError, MongoServerSelectionError } from "mongodb";

/** A lost or timed-out connection to Atlas, which the driver recovers from on its own. Pure. */
export function survivable(e: unknown): boolean {
  return e instanceof MongoNetworkError || e instanceof MongoServerSelectionError;
}

/** Keeps the process alive through Atlas network errors; anything else is logged and exits with code 1. */
export function surviveNetworkDrops(log: (msg: string) => void = (m) => console.error(m)): void {
  const handle = (kind: string) => (e: unknown) => {
    if (survivable(e)) { log(`[atlas] ${kind}, connection lost (worker keeps running, the driver reconnects): ${(e as Error).message}`); return; }
    console.error(e);
    process.exit(1);
  };
  process.on("uncaughtException", handle("uncaught"));
  process.on("unhandledRejection", handle("unhandled rejection"));
}
