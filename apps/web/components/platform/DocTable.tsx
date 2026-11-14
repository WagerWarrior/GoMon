"use client";
/** Latest documents with a side preview: click a row to read the document as fields, copy its JSON, or jump to its session. */
import Link from "next/link";
import { useState } from "react";

const show = (v: unknown) => { if (v == null) return "—"; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return s.length > 80 ? s.slice(0, 79) + "…" : s; };

function Value({ v, depth = 0 }: { v: unknown; depth?: number }) {
  if (v == null) return <span className="muted">null</span>;
  if (Array.isArray(v)) return v.length && depth < 2 ? <ol className="dt-arr">{v.slice(0, 20).map((x, i) => <li key={i}><Value v={x} depth={depth + 1} /></li>)}{v.length > 20 && <li className="muted">… {v.length - 20} more</li>}</ol> : <span className="mono">[{v.length}]</span>;
  if (typeof v === "object") return depth < 2 ? <dl className="dt-obj">{Object.entries(v as object).map(([k, x]) => <div key={k}><dt>{k}</dt><dd><Value v={x} depth={depth + 1} /></dd></div>)}</dl> : <span className="mono">{show(v)}</span>;
  return <span className={typeof v === "string" ? "" : "mono"}>{String(v)}</span>;
}

export default function DocTable({ name, docs, cols }: { name: string; docs: any[]; cols: string[] }) {
  const [sel, setSel] = useState<any | null>(null); const [copied, setCopied] = useState(false);
  const callId = sel ? (name === "calls" ? String(sel._id) : sel.callId) : null;
  return (
    <div className={`dt ${sel ? "open" : ""}`}>
      <div className="dt-table">
        <table className="p-table">
          <thead><tr><th>_id</th>{cols.map((k) => <th key={k}>{k}</th>)}</tr></thead>
          <tbody>{docs.map((d) => (
            <tr key={String(d._id)} onClick={() => setSel(sel?._id === d._id ? null : d)} aria-selected={sel?._id === d._id} className="dt-row">
              <td className="mono small">{show(d._id)}</td>{cols.map((k) => <td key={k} className="small">{show(d[k])}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
      {sel && (
        <aside className="dt-preview">
          <div className="dt-ph"><b className="mono">{show(sel._id)}</b><button className="ad-x" onClick={() => setSel(null)} aria-label="Close">×</button></div>
          <div className="dt-actions">
            <button className="chip" onClick={() => { void navigator.clipboard.writeText(JSON.stringify(sel, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy JSON"}</button>
            {callId && <Link className="chip" href={`/sessions/${encodeURIComponent(callId)}`}>Open session</Link>}
            {callId && <Link className="chip" href={`/sessions/${encodeURIComponent(callId)}?tab=live`}>Live</Link>}
          </div>
          <Value v={sel} />
        </aside>
      )}
    </div>
  );
}
