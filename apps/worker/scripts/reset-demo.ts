/**
 * Put the fraud demo back to its start: the memories it files live (K-05 by default) have no issue again.
 *   npm run reset:demo                 show what would change (read-only)
 *   npm run reset:demo -- --apply      close those issues on GitHub (comment, "not planned") and mark the filings reverted
 *   npm run reset:demo -- K-05 R-17    other keys
 * GitHub cannot delete issues through the API, so the old issue stays, closed. Memories, meetings and the seeded issues
 * 27-32 are not touched.
 */
import { connect, cols, close } from "../src/db.ts";
import { config } from "../src/config.ts";
import { filedIssueQuery } from "../src/github-intent.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const keys = args.filter((a) => !a.startsWith("--"));
if (!keys.length) keys.push("K-05");
const repo = process.env.GITHUB_REPO || "WagerWarrior/MongoDB";
const token = process.env.GITHUB_TOKEN ?? "";
if (apply && !token) throw new Error("GITHUB_TOKEN is not set");

const gh = (path: string, body: unknown, method = "POST") => fetch(`https://api.github.com/repos/${repo}/${path}`, {
  method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" }, body: JSON.stringify(body),
});

const { db } = await connect(); const c = cols(db);
let changed = 0;
for (const key of keys) {
  for (const mem of await c.memories.find({ teamId: config.teamId, key, status: "active" }).project({ _id: 1, text: 1 }).toArray()) {
    const filed = await c.actions.find(filedIssueQuery(config.teamId, mem._id as never)).toArray();
    if (!filed.length) { console.log(`${key}: no issue filed, nothing to reset`); continue; }
    for (const a of filed) {
      const n = Number(/#(\d+)(?::|$)/.exec(String(a.externalId ?? ""))?.[1] ?? 0);
      console.log(`${key}: ${apply ? "resetting" : "would reset"} issue ${n || "(not filed yet)"} (action ${a._id}, ${a.status})`);
      if (!apply) continue;
      if (n) {
        const cm = await gh(`issues/${n}/comments`, { body: "Reset for the next demo run; Gomon files this item again live." });
        const cl = await gh(`issues/${n}`, { state: "closed", state_reason: "not_planned" }, "PATCH");
        if (!cm.ok || !cl.ok) throw new Error(`GitHub: comment ${cm.status}, close ${cl.status} on issue ${n}`);
      }
      await c.actions.updateOne({ _id: a._id }, { $set: { reverted: true, revertedAt: new Date(), revertedBy: "reset-demo" } });
      changed++;
    }
  }
}
console.log(apply ? `done: ${changed} filing(s) reset` : "dry run: nothing changed (add --apply)");
await close();
