# Gomon avatar (design)

Owner: Max (design only). Gomon's face for the bot camera tile, the workspace and Slack.

- `gomon.json`: the avatar definition ([open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar) v1 contract, MIT). A rounded hexagon with one leaf; it passes `validateAvatar`.
- `showcase.html`: one self-contained page (renderer bundled in) with the meeting tile, every state, the loop, the size scale and the handoff spec. Open it in a browser. Rebuild: `npm i && npm run build` (source in `src/`).
- Look: light, monochrome, hairlines. Black body with white eyes on light; near-white body with black eyes on the dark meeting tile.

## State to face (for `apps/bot-page`)

| Gomon state | mood | lookAt | extra |
|---|---|---|---|
| Listening | idle | follow pointer / speaker | |
| Recalling | thinking | 0.55, -0.35 | |
| Speaking | idle | 0, 0 | voice bars |
| Locking | thinking | 0, 0.15 | 10 s ring |
| Locked | happy | 0, -0.2 | |
| Vetoed | idle | -0.1, 0.75 | dimmed body |
| Acting | happy | 0.6, 0.1 | |

```ts
import { mountAvatar } from "open-bot-avatar/dom";
import gomon from "../../design/gomon/gomon.json";
const face = mountAvatar(el, { definition: gomon, color: "#f5f5f5", eyeColor: "#0a0a0a" });
face.update({ mood: "thinking", lookAt: { x: 0, y: 0.15 } }); // on each state change
```
