/** Parse pasted KEY=value lines and merge them into .env text. Pure; tested in test/envfile.test.ts. Values are never logged. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) out[m[1]] = v;
  }
  return out;
}

/** Replace existing KEY= lines in place, append new ones at the end. Other lines are untouched. */
export function mergeEnv(file: string, set: Record<string, string>): string {
  const left = new Map(Object.entries(set));
  const lines = file.split(/\r?\n/).map((l) => {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(l);
    if (m && left.has(m[1])) { const v = left.get(m[1])!; left.delete(m[1]); return `${m[1]}=${v}`; }
    return l;
  });
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [k, v] of left) lines.push(`${k}=${v}`);
  return lines.join("\n") + "\n";
}
