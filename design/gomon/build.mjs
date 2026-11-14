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
