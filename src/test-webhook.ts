/**
 * Local test of the webhook → extraction path without a phone call.
 *   npm run test:webhook
 * Creates a session, attaches a fake conversation id, then POSTs a correctly
 * signed fake post-call transcription to the running server.
 * Requires the server running with the same ELEVENLABS_WEBHOOK_SECRET.
 */
import { createHmac } from "node:crypto";
import { config } from "./config.js";

const secret = config.elevenlabsWebhookSecret;
if (!secret) throw new Error("ELEVENLABS_WEBHOOK_SECRET required for this test");

const conversationId = process.argv[2] ?? "conv_test_" + Math.random().toString(36).slice(2);

const payload = {
  type: "post_call_transcription",
  event_timestamp: Math.floor(Date.now() / 1000),
  data: {
    conversation_id: conversationId,
    status: "done",
    transcript: [
      { role: "agent", message: "Hey Haroon. Claude wants your input. Want the quick version?" },
      { role: "user", message: "Yeah go ahead." },
      { role: "agent", message: "Profession-first or workflow-first for the SEO batch? Claude prefers profession-first." },
      { role: "user", message: "Do a hybrid. Five profession posts first, venues first, then mostly workflow ones. I'm worried about repetitive content." },
      { role: "agent", message: "Got it: hybrid, five profession-specific starting with venues, rest workflow-based. Correct?" },
      { role: "user", message: "Yep." },
    ],
    metadata: { call_duration_secs: 95, termination_reason: "agent ended call" },
    analysis: { transcript_summary: "User chose hybrid strategy." },
  },
};
const body = JSON.stringify(payload);
const ts = Math.floor(Date.now() / 1000).toString();
const sig = "v0=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

const res = await fetch(`${config.serverUrl}/webhooks/elevenlabs`, {
  method: "POST",
  headers: { "content-type": "application/json", "elevenlabs-signature": `t=${ts},${sig}` },
  body,
});
console.log("webhook →", res.status, await res.text());
