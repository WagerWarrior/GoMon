/** Small display helpers shared by the platform pages. */
export function dur(ms: number | null | undefined) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000); if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export function ms(v: number | null | undefined) { return v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`; }
export function when(t: string | null | undefined) {
  if (!t) return "—";
  const d = new Date(t); const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function clock(t: string | null | undefined) { return t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }) : "—"; }
export function initials(n: string) { return n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase(); }
