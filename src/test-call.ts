/** Manual smoke test: `npm run test:call -- "your context here"` (server must be running). */
import { config } from "./config.js";

const context =
  process.argv.slice(2).join(" ") ||
  "I'm testing the ask-human phone loop. There's no real decision — just confirm you can hear me, tell me the loop works, and ask whether we should ship it. Then confirm my answer and hang up.";

console.log("POST /call … (this blocks until the call ends)");
const res = await fetch(`${config.serverUrl}/call`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.askHumanToken}` },
  body: JSON.stringify({ context }),
});
console.log(res.status, await res.text());
