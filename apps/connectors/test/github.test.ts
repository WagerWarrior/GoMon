import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, queue, fakeGithub, TEAM } from "./fakes";
import { processAction } from "../src/outbox";

const envFor = (gh: string) => ({ GITHUB_TOKEN: "t", GITHUB_REPO: "org/repo", GITHUB_API_URL: gh });
const get = (d: any, id: any) => d.collection("actions").findOne({ _id: id });
const retryNow = (d: any, id: any) => d.collection("actions").updateOne({ _id: id }, { $unset: { nextAttemptAt: "" } });

test("github create_issue: assignees, labels (missing ones created), milestone by title, added to the project's board", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    await d.collection("projects").insertOne({ _id: "enterprise-sso" as any, teamId: TEAM, name: "Enterprise SSO", status: "active", github: { projectId: "PVT_9", projectNumber: 9, url: "http://gh.test/users/robot/projects/9" } });
    const id = await queue(d, "github", { payload: { op: "create_issue", title: "R-21: Globex SSO", body: "Globex needs SAML SSO.", assignees: ["naidx0"], labels: ["customer", "enterprise"], milestone: "Beta", project: "enterprise-sso" } });
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    const a = await get(d, id);
    assert.equal(a.status, "confirmed"); assert.equal(a.externalId, "org/repo#1"); assert.equal(a.externalUrl, "http://gh.test/issues/1");
    assert.equal(a.policyCheck.reason, "role lead may github_write"); assert.equal(a.note, undefined);
    const issue = gh.state.issues[0];
    assert.deepEqual(issue.assignees, [{ login: "naidx0" }]);
    assert.deepEqual([...issue.labels].sort(), ["customer", "enterprise", "gomon"]);
    assert.ok(gh.state.labels.includes("customer") && gh.state.labels.includes("enterprise"), "missing labels were created");
    assert.equal(gh.state.milestones.length, 1); assert.equal(gh.state.milestones[0].title, "Beta"); assert.deepEqual(issue.milestone, { number: 1 });
    assert.deepEqual(gh.state.items, [{ board: "PVT_9", content: "I_1" }]);
    assert.ok(issue.body.includes(`gomon-idempotency:${a.idempotencyKey}`));
  } finally { await gh.close(); await done(); }
});

test("github create_issue for a project without a board: the issue is still filed, the note says why it is not on a board", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    await d.collection("projects").insertOne({ _id: "usage-billing" as any, teamId: TEAM, name: "Usage billing", status: "active" });
    const id = await queue(d, "github", { payload: { op: "create_issue", title: "Meter API calls", body: "x", assignees: [], labels: [], project: "usage-billing" } });
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    const a = await get(d, id); assert.equal(a.externalId, "org/repo#1"); assert.match(a.note, /not added to board.*no GitHub board/);
    assert.equal(gh.state.items.length, 0);
  } finally { await gh.close(); await done(); }
});

test("github update_issue close + comment: ambiguous comment failure, retry adopts the comment (posted once), then closes", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    gh.state.issues.push({ number: 12, node_id: "I_12", html_url: "http://gh.test/issues/12", title: "Dup", body: "b", labels: ["gomon"], assignees: [], state: "open" });
    gh.state.issues.unshift(...Array.from({ length: 11 }, (_, i) => ({ number: i + 1, node_id: `I_${i + 1}`, html_url: `http://gh.test/issues/${i + 1}`, title: "x", body: "", labels: [], assignees: [], state: "open" })));
    gh.state.failCommentAfterApply = 1;
    const id = await queue(d, "github", { payload: { op: "update_issue", issue: 12, state: "closed", stateReason: "not_planned", comment: "Closing as a duplicate of #11." } });
    assert.equal(await processAction(d, id, envFor(gh.url)), "requeued");
    assert.equal(gh.state.issues[11].state, "open", "not closed before the comment is recorded");
    await retryNow(d, id);
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    const a = await get(d, id);
    assert.equal(gh.state.commentPosts, 1, "comment posted exactly once"); assert.equal(gh.state.comments.length, 1);
    assert.equal(gh.state.issues[11].state, "closed"); assert.equal(gh.state.issues[11].state_reason, "not_planned");
    assert.equal(a.externalId, `org/repo#12:update_issue:${a.idempotencyKey}`); assert.match(a.note, /adopted earlier comment/);
    assert.equal(a.status, "confirmed");
    // A second, different request on the same issue gets its own unique externalId (the partial unique index on externalId).
    const id2 = await queue(d, "github", { payload: { op: "update_issue", issue: 12, addAssignees: ["WagerWarrior", "ghost"] } });
    gh.state.knownLogins = ["WagerWarrior"];
    assert.equal(await processAction(d, id2, envFor(gh.url)), "sent");
    const b = await get(d, id2);
    assert.notEqual(b.externalId, a.externalId); assert.deepEqual(gh.state.issues[11].assignees, [{ login: "WagerWarrior" }]);
    assert.match(b.note, /assignee not accepted by GitHub: ghost/);
  } finally { await gh.close(); await done(); }
});

test("github create_project: board created, linked to the repo, recorded on projects.github; a retry adopts the board by title", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    await d.collection("projects").insertOne({ _id: "usage-billing" as any, teamId: TEAM, name: "Usage billing", status: "active" });
    gh.state.failCreateBoardAfterApply = 1;
    const id = await queue(d, "github", { requestedBy: "Priya", payload: { op: "create_project", project: "usage-billing", title: "Usage billing", description: "Metered billing for the public API" } });
    assert.equal(await processAction(d, id, envFor(gh.url)), "requeued");
    await retryNow(d, id);
    assert.equal(await processAction(d, id, envFor(gh.url)), "sent");
    const a = await get(d, id);
    assert.equal(gh.state.boardCreates, 1, "board created once"); assert.equal(gh.state.boards.length, 1);
    assert.equal(a.externalId, "project:robot/1"); assert.equal(a.externalUrl, "http://gh.test/users/robot/projects/1");
    assert.equal(a.policyCheck.reason, "role lead may create_project"); assert.equal(a.status, "confirmed");
    const p: any = await d.collection("projects").findOne({ _id: "usage-billing" as any });
    assert.deepEqual(p.github, { projectNumber: 1, projectId: "PVT_1", url: "http://gh.test/users/robot/projects/1" });
    assert.deepEqual(gh.state.links, [{ board: "PVT_1", repo: "R_org/repo" }]);
    assert.equal(gh.state.boards[0].shortDescription, "Metered billing for the public API");
    // Observers may not create projects: denied before any GitHub call.
    const before = gh.state.boardCreates;
    const denied = await queue(d, "github", { requestedBy: "Lena", payload: { op: "create_project", project: "usage-billing", title: "Usage billing" } });
    assert.equal(await processAction(d, denied, envFor(gh.url)), "denied"); assert.equal(gh.state.boardCreates, before);
  } finally { await gh.close(); await done(); }
});

test("github add_to_project and create_milestone (find-or-create by title, never a second Beta)", async () => {
  const { d, done } = await freshDb(); const gh = await fakeGithub();
  try {
    await d.collection("projects").insertOne({ _id: "enterprise-sso" as any, teamId: TEAM, name: "Enterprise SSO", status: "active", github: { projectId: "PVT_3", projectNumber: 3, url: "http://gh.test/users/robot/projects/3" } });
    gh.state.issues.push({ number: 1, node_id: "I_1", html_url: "http://gh.test/issues/1", title: "x", body: "", labels: [], assignees: [], state: "open" });
    const add = await queue(d, "github", { payload: { op: "add_to_project", issue: 1, project: "enterprise-sso" } });
    assert.equal(await processAction(d, add, envFor(gh.url)), "sent");
    assert.deepEqual(gh.state.items, [{ board: "PVT_3", content: "I_1" }]);
    const m1 = await queue(d, "github", { payload: { op: "create_milestone", title: "Beta", dueOn: "2026-12-01T12:00:00Z" } });
    const m2 = await queue(d, "github", { payload: { op: "create_milestone", title: "beta" } });
    assert.equal(await processAction(d, m1, envFor(gh.url)), "sent"); assert.equal(await processAction(d, m2, envFor(gh.url)), "sent");
    assert.equal(gh.state.milestones.length, 1); assert.equal(gh.state.milestones[0].due_on, "2026-12-01T12:00:00Z");
    const [x, y] = [await get(d, m1), await get(d, m2)];
    assert.equal(x.status, "confirmed"); assert.notEqual(x.externalId, y.externalId);
  } finally { await gh.close(); await done(); }
});
