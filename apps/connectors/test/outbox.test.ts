import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, queue, fakeGithub, fakeSlack } from "./fakes";
import { processAction, dueActionIds } from "../src/outbox";

const envFor = (gh?: string, sl?: string) => ({ GITHUB_TOKEN: "t", GITHUB_REPO: "org/repo", GITHUB_API_URL: gh, SLACK_BOT_TOKEN: "t", SLACK_CHANNEL_ID: "C1", SLACK_API_URL: sl });
const get = (d: any, id: any) => d.collection("actions").findOne({ _id: id });

test("GitHub happy path: policy recorded, issue created, externalId stored with status, then confirmed, audited", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    const id = await queue(d, "create_issue");
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    const a = await get(d, id);
    assert.equal(a.status, "confirmed"); assert.equal(a.externalId, "org/repo#1"); assert.match(a.externalUrl, /issues\/1$/);
    assert.equal(a.policyCheck.allowed, true); assert.ok(a.policyCheck.policyId);
    assert.ok(gh.state.issues[0].body.includes(`gomon-idempotency:${a.idempotencyKey}`)); assert.ok(gh.state.issues[0].labels.includes("gomon"));
    const ev = await d.collection("audit_events").find({}).toArray();
    assert.ok(ev.some((e: any) => e.type === "action_sent" && e.ref.externalId === "org/repo#1"));
  } finally { await gh.close(); await done(); }
});

test("a denied policy sends NOTHING (zero HTTP calls), records the denial, and audits it", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    const id = await queue(d, "create_issue", { requestedBy: "Lena" }); // observer: not in allowedRoles
    assert.equal(await processAction(d, id, envFor(gh.url)), "denied");
    const a = await get(d, id);
    assert.equal(a.status, "denied"); assert.equal(a.policyCheck.allowed, false); assert.equal(a.externalId, undefined);
    assert.equal(gh.state.posts + gh.state.lists, 0);
    assert.equal(await d.collection("audit_events").countDocuments({ type: "action_denied" }), 1);
    const unknown = await queue(d, "create_issue", { requestedBy: "Ghost" });
    assert.equal(await processAction(d, unknown, envFor(gh.url)), "denied"); assert.equal(gh.state.posts, 0);
  } finally { await gh.close(); await done(); }
});

test("concurrent processing of one action sends exactly once (atomic claim)", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    const id = await queue(d, "create_issue");
    const outs = await Promise.all([1, 2, 3, 4].map(() => processAction(d, id, envFor(gh.url))));
    assert.equal(outs.filter((o) => o === "sent").length, 1); assert.equal(outs.filter((o) => o === "skipped").length, 3);
    assert.equal(gh.state.issues.length, 1);
  } finally { await gh.close(); await done(); }
});

test("ambiguous failure (GitHub applied the write then returned 502): retry ADOPTS the issue, never duplicates", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    gh.state.failCreateAfterApply = 1;
    const id = await queue(d, "create_issue");
    assert.equal(await processAction(d, id, envFor(gh.url)), "requeued");
    let a = await get(d, id); assert.equal(a.status, "queued"); assert.equal(a.externalId, undefined); assert.ok(a.nextAttemptAt > new Date());
    await d.collection("actions").updateOne({ _id: id }, { $unset: { nextAttemptAt: "" } }); // backoff elapsed
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    a = await get(d, id);
    assert.equal(gh.state.issues.length, 1, "exactly one issue exists");
    assert.equal(a.externalId, "org/repo#1"); assert.equal(a.note, "adopted earlier attempt"); assert.equal(gh.state.posts, 1);
  } finally { await gh.close(); await done(); }
});

test("permanent errors stop (401) and missing config fails clearly; rate limit backs off", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    gh.state.status = 401;
    const a1 = await queue(d, "create_issue");
    assert.equal(await processAction(d, a1, envFor(gh.url)), "failed");
    assert.match((await get(d, a1)).error, /401/);
    gh.state.status = 0; gh.state.rateLimit = true;
    const a2 = await queue(d, "create_issue");
    assert.equal(await processAction(d, a2, envFor(gh.url)), "requeued");
    const x = await get(d, a2); assert.equal(x.status, "queued"); assert.ok(x.nextAttemptAt.getTime() - Date.now() > 500);
    assert.equal((await dueActionIds(d)).map(String).includes(String(a2)), false, "not due until backoff elapses");
    const a3 = await queue(d, "create_issue");
    assert.equal(await processAction(d, a3, { GITHUB_API_URL: gh.url }), "failed");
    assert.match((await get(d, a3)).error, /GITHUB_TOKEN is not set/);
  } finally { await gh.close(); await done(); }
});

test("an unknown assignee does not lose the issue: it is created unassigned and the note says so", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    gh.state.assigneeReject = true;
    const id = await queue(d, "create_issue", { payload: { title: "T", body: "B", assignees: ["nobody-here"] } });
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    const a = await get(d, id); assert.match(a.note, /unassigned/); assert.equal(gh.state.issues.length, 1);
  } finally { await gh.close(); await done(); }
});

test("Slack: one thread per call (root once, then replies), metadata carries the idempotency key", async () => {
  const { d, done } = await freshDb(); const sl = await fakeSlack();
  try {
    const a1 = await queue(d, "post_slack"), a2 = await queue(d, "post_slack", { payload: { text: "Second decision" } });
    await Promise.all([processAction(d, a1, envFor(undefined, sl.url)), processAction(d, a2, envFor(undefined, sl.url))]);
    const roots = sl.state.msgs.filter((m) => !m.thread_ts); const replies = sl.state.msgs.filter((m) => m.thread_ts);
    assert.equal(roots.length, 1, "exactly one thread root"); assert.equal(replies.length, 2);
    assert.ok(replies.every((m) => m.thread_ts === roots[0].ts));
    const call: any = await d.collection("calls").findOne({ _id: "call-1" as any }); assert.equal(call.slackThreadTs, roots[0].ts);
    const done1 = await get(d, a1); assert.equal(done1.status, "confirmed", "read back from the thread by metadata"); assert.match(done1.externalId, /^C1:\d+\.\d+$/);
    assert.equal(replies.find((m) => m.text.startsWith("Decision"))!.metadata.event_payload.idempotencyKey, done1.idempotencyKey);
  } finally { await sl.close(); await done(); }
});

test("Slack ambiguous failure: message was posted but the response failed; retry finds it by metadata, no duplicate", async () => {
  const { d, done } = await freshDb(); const sl = await fakeSlack();
  try {
    const first = await queue(d, "post_slack"); await processAction(d, first, envFor(undefined, sl.url)); // establishes the thread
    sl.state.failAfterApply = 1;
    const id = await queue(d, "post_slack", { payload: { text: "Flaky one" } });
    assert.equal(await processAction(d, id, envFor(undefined, sl.url)), "requeued");
    await d.collection("actions").updateOne({ _id: id }, { $unset: { nextAttemptAt: "" } });
    assert.equal(await processAction(d, id, envFor(undefined, sl.url)), "sent");
    assert.equal(sl.state.msgs.filter((m) => m.text === "Flaky one").length, 1, "posted exactly once");
    assert.equal((await get(d, id)).note, "adopted earlier attempt");
  } finally { await sl.close(); await done(); }
});

test("Slack permanent error (channel_not_found) fails without retry", async () => {
  const { d, done } = await freshDb(); const sl = await fakeSlack();
  try {
    sl.state.error = "channel_not_found"; const id = await queue(d, "post_slack");
    assert.equal(await processAction(d, id, envFor(undefined, sl.url)), "failed"); assert.match((await get(d, id)).error, /channel_not_found/);
  } finally { await sl.close(); await done(); }
});

test("a worker that died mid-send is recovered: the stuck claim is re-queued and looks for the earlier side effect first", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    const id = await queue(d, "create_issue");
    // Simulate: claim taken (attempts=1), GitHub applied the issue, then the worker crashed before recording it.
    await d.collection("actions").updateOne({ _id: id }, { $set: { status: "sending", attempts: 1, updatedAt: new Date(Date.now() - 120000) } });
    const key = (await get(d, id)).idempotencyKey;
    gh.state.issues.push({ number: 1, html_url: "http://gh.test/issues/1", title: "Tiered limits", body: `x\n\n<!-- gomon-idempotency:${key} -->`, labels: ["gomon"] });
    const due = await dueActionIds(d); assert.ok(due.map(String).includes(String(id)));
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    assert.equal(gh.state.issues.length, 1); assert.equal((await get(d, id)).externalId, "org/repo#1");
  } finally { await gh.close(); await done(); }
});

test("works under the spec's actions validator: 'sent' requires policyCheck.allowed and requestedBy", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    await d.command({ collMod: "actions", validator: { $or: [{ status: { $nin: ["sent", "confirmed"] } }, { $and: [{ "policyCheck.allowed": true }, { requestedBy: { $type: "string" } }, { externalId: { $type: "string" } }] }] }, validationAction: "error" });
    const id = await queue(d, "create_issue");
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    assert.ok(["sent", "confirmed"].includes((await get(d, id)).status));
    await assert.rejects(d.collection("actions").updateOne({ _id: id }, { $set: { "policyCheck.allowed": false } }), /validation/i); // positive control: the validator really bites
  } finally { await gh.close(); await done(); }
});

test("Slack read-back that cannot see the message leaves the action 'sent', never confirmed", async () => {
  const { d, done } = await freshDb(); const sl = await fakeSlack();
  try {
    const id = await queue(d, "post_slack"); await processAction(d, id, envFor(undefined, sl.url));
    assert.equal((await get(d, id)).status, "confirmed");
    sl.state.msgs.length = 0; // message vanished (deleted, or the bot cannot read the channel)
    const id2 = await queue(d, "post_slack", { payload: { text: "Another" } });
    sl.state.hideReads = true; await processAction(d, id2, envFor(undefined, sl.url));
    assert.equal((await get(d, id2)).status, "sent");
  } finally { await sl.close(); await done(); }
});
