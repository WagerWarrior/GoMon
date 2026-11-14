"use client";
/** Re-reads the server page every few seconds so dashboards follow Atlas without a reload. Pauses while the tab is hidden. */
import { useRouter } from "next/navigation";
import { useEffect } from "react";
export default function AutoRefresh({ ms = 5000 }: { ms?: number }) {
  const r = useRouter();
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) r.refresh(); }, ms); return () => clearInterval(t); }, [r, ms]);
  return null;
}
