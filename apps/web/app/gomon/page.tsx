"use client";
/** /gomon: every face Gomon can make, live. Design source: design/gomon. */
import { useState } from "react";
import GomonAvatar from "@/components/GomonAvatar";
import { GOMON_STATES, GOMON_THEME, type GomonStateKey } from "@/lib/gomon/states";

const KEYS = Object.keys(GOMON_STATES) as GomonStateKey[];

export default function GomonPage() {
  const [state, setState] = useState<GomonStateKey>("listening");
  const s = GOMON_STATES[state];
  return (
    <div className="gm">
      <header className="gm-top"><a href="/" className="gm-brand"><GomonAvatar size={26} label="" />Gomon</a><span className="eyebrow">Avatar</span></header>
      <section className="gm-hero">
        <span className="eyebrow">The bot in your design call</span>
        <h1 className="gm-title">Gomon</h1>
        <p className="gm-lede">Listens to the call, remembers what the team decides, and acts only on what the room locks.</p>
        <GomonAvatar state={state} size="min(320px, 70vw)" />
        <div className="gm-caption"><span className="live-dot" data-muted={s.muted ? "1" : undefined} />{s.label}<span className="muted">{s.line}</span></div>
        <div className="pills" role="group" aria-label="Gomon states">
          {KEYS.map((k) => <button key={k} className="chip" aria-pressed={k === state} onClick={() => setState(k)}>{GOMON_STATES[k].label}</button>)}
        </div>
      </section>
      <section className="gm-band">
        <span className="eyebrow">States</span>
        <h2 className="gm-h2">Seven faces, no words needed</h2>
        <div className="gm-states">
          {KEYS.map((k) => <div key={k} className="gm-state"><GomonAvatar state={k} size={112} label={`Gomon ${k}`} /><b>{GOMON_STATES[k].label}</b><span className="muted">{GOMON_STATES[k].line}</span></div>)}
        </div>
      </section>
      <section className="gm-band">
        <span className="eyebrow">Theme</span>
        <div className="gm-swatches">
          {Object.entries({ Leaf: GOMON_THEME.leaf, Eyes: GOMON_THEME.eye, Muted: GOMON_THEME.rest }).map(([n, c]) => <div key={n} className="gm-swatch"><i style={{ background: c }} /><b>{n}</b><code>{c}</code></div>)}
          <div className="gm-swatch"><i className="depth" /><b>Depth</b><code>{GOMON_THEME.depth}</code></div>
        </div>
      </section>
    </div>
  );
}
