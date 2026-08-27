/**
 * Create (or re-point) the ElevenLabs post-call webhook at PUBLIC_URL/webhooks/elevenlabs
 * and make it the workspace's post-call webhook (transcript + call_initiation_failure events).
 * Writes ELEVENLABS_WEBHOOK_SECRET into .env when a new webhook is created.
 *   npm run configure-webhook
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { config } from "./config.js";

const NAME = "ask-human post-call";
const url = `${config.publicUrl().replace(/\/$/, "")}/webhooks/elevenlabs`;
const client = new ElevenLabsClient({ apiKey: config.elevenlabsApiKey() });

const existing = (await client.webhooks.list({})).webhooks.find((w) => w.name === NAME);
let webhookId: string;
let secret: string | undefined;

if (existing && existing.webhookUrl === url) {
  webhookId = existing.webhookId;
  console.log("webhook already exists with this URL:", webhookId);
} else {
  // URL isn't editable — create a replacement (new secret), reassign, then delete the old one.
  const created = await client.webhooks.create({ settings: { authType: "hmac", name: NAME, webhookUrl: url } });
  webhookId = created.webhookId;
  secret = created.webhookSecret;
  console.log("webhook created:", webhookId, "→", url);
}

await client.conversationalAi.settings.update({
  webhooks: { postCallWebhookId: webhookId, events: ["transcript", "call_initiation_failure"] },
});
console.log("workspace post-call webhook set");

if (existing && existing.webhookId !== webhookId) {
  await client.webhooks.delete(existing.webhookId);
  console.log("old webhook deleted");
}

if (secret) {
  const envPath = new URL("../.env", import.meta.url);
  const env = readFileSync(envPath, "utf8").replace(/\n?$/, "\n"); // always end with a newline before appending
  const next = env.match(/^ELEVENLABS_WEBHOOK_SECRET=.*$/m)
    ? env.replace(/^ELEVENLABS_WEBHOOK_SECRET=.*$/m, `ELEVENLABS_WEBHOOK_SECRET=${secret}`)
    : env + `\nELEVENLABS_WEBHOOK_SECRET=${secret}\n`;
  writeFileSync(envPath, next);
  console.log("ELEVENLABS_WEBHOOK_SECRET written to .env");
} else if (!config.elevenlabsWebhookSecret) {
  console.warn("WARNING: webhook existed already but .env has no ELEVENLABS_WEBHOOK_SECRET — delete the webhook in the dashboard and re-run to get a fresh secret.");
}
