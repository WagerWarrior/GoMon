import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoNetworkError, MongoNetworkTimeoutError, MongoServerSelectionError, MongoParseError } from "mongodb";
import { survivable } from "../src/survive.ts";

// Live, Nov 15: the Mac changed networks, the driver threw PoolClearedOnNetworkError (a MongoNetworkError) outside any
// await, and the worker exited. A dropped connection to Atlas is weather: the driver reconnects on its own.
test("a lost or timed-out connection to Atlas does not end the worker", () => {
  assert.equal(survivable(new MongoNetworkError("Connection interrupted due to server monitor timeout")), true);
  assert.equal(survivable(new MongoNetworkTimeoutError("connection <monitor> timed out")), true);
  assert.equal(survivable(new MongoServerSelectionError("getaddrinfo ENOTFOUND cluster0", {} as never)), true);
});

test("a real bug still ends the worker", () => {
  assert.equal(survivable(new TypeError("x is undefined")), false);
  assert.equal(survivable(new MongoParseError("bad uri")), false);
  assert.equal(survivable("a string"), false);
});
