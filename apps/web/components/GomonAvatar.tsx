"use client";
/** Gomon's living face (open-bot-avatar, MIT). Pass a state key; the face, gaze and color follow GOMON_STATES. */
import { useEffect, useRef } from "react";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { GOMON_DEFINITION, GOMON_STATES, GOMON_THEME, type GomonStateKey } from "@/lib/gomon/states";

export default function GomonAvatar({ state = "listening", size = 96, label = "Gomon", className }: { state?: GomonStateKey; size?: number | string; label?: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const face = useRef<MountedAvatar | null>(null);
  const look = (k: GomonStateKey) => {
    const s = GOMON_STATES[k];
    return { mood: s.mood, color: s.muted ? GOMON_THEME.rest : GOMON_THEME.leaf, followPointer: !!s.follow, lookAt: s.look };
  };
  useEffect(() => {
    face.current = mountAvatar(host.current!, { definition: GOMON_DEFINITION as any, eyeColor: GOMON_THEME.eye, depth: GOMON_THEME.depth, label, ...look(state) });
    return () => { face.current?.destroy(); face.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { face.current?.update(look(state)); }, [state]);
  return <div ref={host} className={className} style={{ width: size, aspectRatio: "1", flex: "none" }} />;
}
