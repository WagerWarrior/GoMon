import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePerson, soundsLikePerson, type Person } from "../src/people.ts";

const PEOPLE: Person[] = [
  { display: "Max", login: "naidx0", names: ["max naidenov", "max"] },
  { display: "Rob", login: "robreder", names: ["robert reder", "robert", "rob"] },
  { display: "Tamir", login: "tamirazbel", names: ["tamir azbel", "tamir"] },
];

// Live, call-202611142054-291b: "assign this to Nade X0" -> "I don't know Nade X0's GitHub."
test("a misheard GitHub login resolves to the one person it sounds like", () => {
  assert.equal(resolvePerson(PEOPLE, "Nade X0", "Robert Reder")?.login, "naidx0");
  assert.equal(resolvePerson(PEOPLE, "Tamer", "Robert Reder")?.login, "tamirazbel");
  assert.equal(resolvePerson(PEOPLE, "Robert Reader", "Max")?.login, "robreder");
});
test("exact names and 'me' still win", () => {
  assert.equal(resolvePerson(PEOPLE, "max", "Robert Reder")?.login, "naidx0");
  assert.equal(resolvePerson(PEOPLE, "me", "Robert Reder")?.login, "robreder");
});
test("an unknown or too-short name is not guessed", () => {
  assert.equal(resolvePerson(PEOPLE, "Lena", "Max"), null);
  assert.equal(resolvePerson(PEOPLE, "Priya Raman", "Max"), null);
  assert.equal(soundsLikePerson(PEOPLE, "ma"), null);
});
test("a name equally close to two people is not guessed", () => {
  const twins: Person[] = [{ display: "Dana", login: "danak", names: ["dana"] }, { display: "Dane", login: "danek", names: ["dane"] }];
  assert.equal(soundsLikePerson(twins, "danok"), null);
});
test("a learned alias is an exact match", () => {
  const learned = PEOPLE.map((p) => (p.login === "naidx0" ? { ...p, names: [...p.names, "nade x zero"] } : p));
  assert.equal(resolvePerson(learned, "Nade X Zero", "Rob")?.login, "naidx0");
});
