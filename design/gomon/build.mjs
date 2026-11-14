// Builds showcase.html: one self-contained page with open-bot-avatar (MIT) bundled in, plus gomon.json.
import { build } from "esbuild";
import fs from "fs";
import { validateAvatar } from "open-bot-avatar";
const def = JSON.parse(fs.readFileSync("gomon.json", "utf8"));
const v = validateAvatar(def); if (!v.ok) { console.error(v.errors); process.exit(1); }
const out = await build({ stdin: { contents: 'export { mountAvatar } from "open-bot-avatar/dom"; export { renderAvatarSvg } from "open-bot-avatar";', resolveDir: "." },
  bundle: true, minify: true, format: "iife", globalName: "OBA", write: false });
const lib = "/*! open-bot-avatar 0.2.1 | MIT | (c) 2026 Dominik Scholz */\n" + out.outputFiles[0].text;
const src = fs.readFileSync("src/showcase.src.html", "utf8");
fs.writeFileSync("showcase.html", src.replace("/*OBA*/", () => lib).replace("/*DEF*/", () => JSON.stringify(def)));
console.log("showcase.html", fs.statSync("showcase.html").size, "bytes");

// Bot page (apps/bot-page): one script, window.GomonFace, built from the web app's states so both stay in step.
const face = await build({
  stdin: { resolveDir: ".", contents: `
    import { mountAvatar } from "open-bot-avatar/dom";
    import { GOMON_DEFINITION, GOMON_STATES, GOMON_THEME } from "../../apps/web/lib/gomon/states.ts";
    function look(k) { const s = GOMON_STATES[k] || GOMON_STATES.listening;
      return { mood: s.mood, color: s.muted ? GOMON_THEME.rest : GOMON_THEME.leaf, followPointer: !!s.follow, lookAt: s.look }; }
    window.GomonFace = { STATES: GOMON_STATES, THEME: GOMON_THEME,
      mount(el, state = "listening") {
        const a = mountAvatar(el, { definition: GOMON_DEFINITION, eyeColor: GOMON_THEME.eye, depth: GOMON_THEME.depth, label: "Gomon", ...look(state) });
        return { set: (k) => a.update(look(k)), destroy: () => a.destroy() };
      } };` },
  bundle: true, minify: true, format: "iife", write: false });
fs.writeFileSync("../../apps/bot-page/public/gomon-avatar.js",
  "/*! Gomon face. Built by design/gomon/build.mjs from apps/web/lib/gomon. open-bot-avatar 0.2.1 | MIT | (c) 2026 Dominik Scholz */\n" + face.outputFiles[0].text);
console.log("apps/bot-page/public/gomon-avatar.js", fs.statSync("../../apps/bot-page/public/gomon-avatar.js").size, "bytes");
