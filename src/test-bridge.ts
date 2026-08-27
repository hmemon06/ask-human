/**
 * Simulates Twilio: POST /call, then open /twilio/media and send a fake "start" event
 * for the pending session. With dummy ElevenLabs creds the bridge fails to get a signed
 * URL, closes, and /call resolves "unavailable". With real creds you'd see the agent
 * open a conversation (no audio flows, so it'll sit until you close it).
 *   npm run test:bridge
 */
import { WebSocket } from "ws";
import { config } from "./config.js";

const auth = { Authorization: `Bearer ${config.askHumanToken}`, "content-type": "application/json" };

const callP = fetch(`${config.serverUrl}/call`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ context: "Bridge test briefing: nothing to decide, just checking the audio path." }),
}).then(async (r) => ({ status: r.status, body: await r.text() }));

// Give the server a moment to create the session (Twilio call creation will fail with dummy creds
// and resolve immediately, so also handle that path).
await new Promise((r) => setTimeout(r, 1500));
const sessions = (await fetch(`${config.serverUrl}/sessions`, { headers: auth }).then((r) => r.json())) as any[];
const pending = sessions.find((s) => s.status !== "done");

if (pending) {
  const ws = new WebSocket(config.serverUrl.replace(/^http/, "ws") + "/twilio/media");
  ws.on("open", () => {
    ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    ws.send(
      JSON.stringify({
        event: "start",
        streamSid: "MZtest",
        start: { streamSid: "MZtest", callSid: "CAtest", customParameters: { sessionId: pending.id } },
      })
    );
  });
  ws.on("message", (d) => console.log("twilio<-", d.toString().slice(0, 100)));
  ws.on("close", () => console.log("twilio ws closed by server"));
} else {
  console.log("no pending session (Twilio call creation probably failed fast — expected with dummy creds)");
}

console.log("/call →", await callP);
process.exit(0);
