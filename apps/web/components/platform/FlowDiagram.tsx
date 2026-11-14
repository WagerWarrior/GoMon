/**
 * Workflow diagram: meeting -> locked -> policy -> one branch per connected tool -> read-back.
 * Each node shows how many runs reached it (done / waiting / failed). Server-rendered SVG, no client JS.
 */
import type { Run } from "@/lib/workflows";

type Agg = { key: string; label: string; done: number; waiting: number; failed: number };

export default function FlowDiagram({ runs, title }: { runs: Run[]; title?: string }) {
  const keys: { key: string; label: string }[] = [];
  for (const r of runs) for (const s of r.steps) if (!keys.some((k) => k.key === s.key)) keys.push({ key: s.key, label: s.label });
  if (!keys.length) keys.push({ key: "meeting", label: "Meeting" }, { key: "lock", label: "Locked" }, { key: "policy", label: "Policy" }, { key: "confirm", label: "Read-back" });
  const agg = new Map<string, Agg>(keys.map((k) => [k.key, { ...k, done: 0, waiting: 0, failed: 0 }]));
  for (const r of runs) for (const s of r.steps) { const a = agg.get(s.key)!; if (s.state === "done") a.done++; else if (s.state === "waiting") a.waiting++; else if (s.state === "failed") a.failed++; }
  const spine = ["meeting", "lock", "policy"].map((k) => agg.get(k)).filter(Boolean) as Agg[];
  const tools = [...agg.values()].filter((a) => !["meeting", "lock", "policy", "confirm"].includes(a.key));
  const end = agg.get("confirm");

  const W = 170, H = 62, GX = 46, rows = Math.max(1, tools.length), GY = 18;
  const height = Math.max(H + 40, rows * H + (rows - 1) * GY + 40);
  const cy = height / 2;
  const col = (i: number) => 10 + i * (W + GX);
  const toolY = (i: number) => cy - (rows * H + (rows - 1) * GY) / 2 + i * (H + GY);
  const width = col(spine.length + (tools.length ? 1 : 0) + (end ? 1 : 0)) - GX + 10;
  const state = (a: Agg) => (a.failed ? "failed" : a.done ? "done" : a.waiting ? "waiting" : "idle");
  const sub = (a: Agg) => [a.done && `${a.done} done`, a.waiting && `${a.waiting} waiting`, a.failed && `${a.failed} failed`].filter(Boolean).join(" · ") || "not reached";
  const Node = ({ a, x, y }: { a: Agg; x: number; y: number }) => (
    <g className={`fd-node fd-${state(a)}`} transform={`translate(${x},${y})`}>
      <rect width={W} height={H} rx="12" />
      <circle cx="16" cy="21" r="4" />
      <text x="28" y="25" className="fd-t">{a.label}</text>
      <text x="16" y="46" className="fd-s">{sub(a)}</text>
    </g>
  );
  const edge = (x1: number, y1: number, x2: number, y2: number, on: boolean, k: string) => {
    const mx = (x1 + x2) / 2;
    return <path key={k} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} className={`fd-edge ${on ? "on" : ""}`} />;
  };
  const toolCol = spine.length; const endCol = toolCol + (tools.length ? 1 : 0);
  const lastSpine = spine[spine.length - 1];

  return (
    <figure className="fd">
      {title && <figcaption className="muted small">{title}</figcaption>}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ maxWidth: width }} role="img" aria-label="Workflow diagram">
        {spine.slice(1).map((a, i) => edge(col(i) + W, cy, col(i + 1), cy, a.done > 0, `s${i}`))}
        {tools.map((t, i) => edge(col(toolCol - 1) + W, cy, col(toolCol), toolY(i) + H / 2, t.done + t.waiting + t.failed > 0, `t${i}`))}
        {end && tools.map((t, i) => edge(col(toolCol) + W, toolY(i) + H / 2, col(endCol), cy, t.done > 0 && end.done > 0, `e${i}`))}
        {end && !tools.length && lastSpine && edge(col(spine.length - 1) + W, cy, col(endCol), cy, end.done > 0, "e")}
        {spine.map((a, i) => <Node key={a.key} a={a} x={col(i)} y={cy - H / 2} />)}
        {tools.map((t, i) => <Node key={t.key} a={t} x={col(toolCol)} y={toolY(i)} />)}
        {end && <Node a={end} x={col(endCol)} y={cy - H / 2} />}
      </svg>
      {!tools.length && <span className="muted small">No tools connected yet. Enable a workflow to send locked decisions somewhere.</span>}
    </figure>
  );
}
