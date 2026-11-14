/**
 * One readable line per outbox action. Slack/issue actions show their title or text; `type: "github"` actions name the op
 * and its target (payload shape: apps/connectors github ops), so new ops still render as "<op> …" instead of breaking a view.
 */
/** Any outbox row (typed ActionDoc or raw Mongo document); only `type` and `payload` are read. */
type ActionLike = { type?: unknown; payload?: unknown };

const payloadOf = (a: ActionLike): Record<string, unknown> => (a.payload && typeof a.payload === "object" ? (a.payload as Record<string, unknown>) : {});

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/** The tool-specific verb, e.g. "github create issue" or "post slack". */
export function actionKind(row: object): string {
  const a = row as ActionLike;
  const type = String(a.type ?? "action");
  return type === "github" ? `github ${String(payloadOf(a).op ?? "").replace(/_/g, " ")}`.trim() : type.replace(/_/g, " ");
}

export function describeAction(row: object): string {
  const a = row as ActionLike;
  const p = payloadOf(a);
  if (a.type !== "github") return String(p.title ?? p.text ?? "—");
  const issue = typeof p.issue === "number" ? `#${p.issue}` : "";
  const people = (k: string) => list(p[k]).map((x) => `@${x}`).join(", ");
  switch (p.op) {
    case "create_issue": {
      const extra = [people("assignees") && `for ${people("assignees")}`, list(p.labels).length && `[${list(p.labels).join(", ")}]`, p.milestone && `milestone ${p.milestone}`, p.project && `on board ${p.project}`].filter(Boolean);
      return `New issue: ${String(p.title ?? "")}${extra.length ? ` (${extra.join(", ")})` : ""}`;
    }
    case "update_issue": {
      const changes = [
        people("addAssignees") && `assign ${people("addAssignees")}`, people("removeAssignees") && `unassign ${people("removeAssignees")}`,
        list(p.addLabels).length && `label ${list(p.addLabels).join(", ")}`, p.state === "closed" ? `close${p.stateReason ? ` (${String(p.stateReason).replace(/_/g, " ")})` : ""}` : p.state === "open" && "reopen",
        p.title && `retitle "${p.title}"`, p.comment && `comment "${String(p.comment).slice(0, 60)}"`,
      ].filter(Boolean);
      return `${issue || "issue"}: ${changes.join("; ") || "update"}`;
    }
    case "create_project": return `New board: ${String(p.title ?? p.project ?? "")}`;
    case "add_to_project": return `${issue || "issue"} → board ${String(p.project ?? "")}`;
    case "create_milestone": return `Milestone: ${String(p.title ?? "")}${p.dueOn ? ` (due ${String(p.dueOn).slice(0, 10)})` : ""}`;
    default: return `${String(p.op ?? "github").replace(/_/g, " ")} ${issue}`.trim();
  }
}
