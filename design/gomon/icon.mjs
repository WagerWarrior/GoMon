// Slack / app icon: the Gomon leaf (happy-neutral face) centred on a light tile. Writes icon.svg; Chrome rasterises it.
import fs from "fs";
import { renderAvatarSvg } from "open-bot-avatar";
const def = JSON.parse(fs.readFileSync("gomon.json", "utf8"));
const svg = renderAvatarSvg(def, { color: "#1f9d55", eyeColor: "#0b2418", depth: 11, size: 760, gaze: { x: 0, y: 0 } });
fs.writeFileSync("icon.html", `<!doctype html><html><body style="margin:0;width:1024px;height:1024px;background:#f4f7f5;display:grid;place-items:center">${svg}</body></html>`);
console.log("icon.html written");
