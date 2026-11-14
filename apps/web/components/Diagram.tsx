"use client";
import { useEffect, useRef, useState } from "react";

/** Renders Mermaid source generated from active memories (lib/mermaid.ts). Re-renders when the source changes. */
export default function Diagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", fontFamily: "-apple-system, system-ui, sans-serif" });
        const { svg } = await mermaid.render("g" + Math.random().toString(36).slice(2), source);
        if (!cancelled && ref.current) { ref.current.innerHTML = svg; setErr(null); }
      } catch (e: any) { if (!cancelled) setErr(String(e?.message ?? e)); }
    })();
    return () => { cancelled = true; };
  }, [source]);
  return <>{err ? <p className="muted">Diagram could not render: {err}</p> : null}<div ref={ref} className="diagram" aria-label="Decision diagram generated from active memories" /></>;
}
