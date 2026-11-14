import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeEnv, parseEnv } from "../lib/envfile";

test("parseEnv reads KEY=value, strips quotes and export, skips comments, blanks and empty values", () => {
  assert.deepEqual(parseEnv('# c\nexport A_KEY="x y"\nB=\'z\'\nlower=1\nC=\n\nD = 4'), { A_KEY: "x y", B: "z", D: "4" });
});

test("mergeEnv replaces in place, keeps other lines, appends new keys once", () => {
  const out = mergeEnv("# top\nA=1\nB=2\n\n", { B: "9", C: "3" });
  assert.equal(out, "# top\nA=1\nB=9\nC=3\n");
});
