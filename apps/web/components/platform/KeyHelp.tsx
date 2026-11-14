"use client";
/** "Add keys" for one service: shows the exact .env lines that are missing and copies them. Values never touch the browser. */
import { useState } from "react";

export default function KeyHelp({ name, missing }: { name: string; missing: string[] }) {
  const [open, setOpen] = useState(false); const [copied, setCopied] = useState(false);
  const lines = missing.map((k) => `${k}=`).join("\n");
  return (
    <div className="kh">
      <button className="kh-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : "Add keys"}</button>
      {open && (
        <div className="kh-pop" role="dialog" aria-label={`Keys for ${name}`}>
          <b>{name}</b>
          <span className="muted small">Paste into <code>.env</code> at the repo root, fill the values, then restart.</span>
          <pre>{lines}</pre>
          <button className="kh-btn dark" onClick={() => { void navigator.clipboard.writeText(lines); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy lines"}</button>
        </div>
      )}
    </div>
  );
}
