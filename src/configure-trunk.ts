/**
 * Register a SIP-trunk phone number (e.g. Telnyx) in ElevenLabs for OUTBOUND calls, assign it to the
 * agent, and write ELEVENLABS_AGENT_PHONE_NUMBER_ID to .env.
 *   npm run configure-trunk
 * Needs in .env: SIP_TRUNK_NUMBER (E.164), SIP_TRUNK_ADDRESS (e.g. sip.telnyx.com),
 *                SIP_TRUNK_USERNAME, SIP_TRUNK_PASSWORD, optional SIP_TRUNK_TRANSPORT (auto|udp|tcp|tls).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k} in .env`);
  return v;
};
const LABEL = "ask-human trunk";
const number = need("SIP_TRUNK_NUMBER");
const headers = { "xi-api-key": config.elevenlabsApiKey(), "content-type": "application/json" };

const outbound_trunk_config = {
  address: need("SIP_TRUNK_ADDRESS"),
  transport: process.env.SIP_TRUNK_TRANSPORT ?? "auto",
  // "disabled" by default: ElevenLabs sends the INVITE over UDP regardless of `transport`, and the
  // SRTP a=crypto lines push the authenticated INVITE past the MTU ("size of packet larger than MTU").
  media_encryption: process.env.SIP_TRUNK_MEDIA_ENCRYPTION ?? "disabled",
  credentials: { username: need("SIP_TRUNK_USERNAME"), password: need("SIP_TRUNK_PASSWORD") },
  // Keep the SDP small (a fat INVITE overflows UDP MTU) — PSTN audio is 8 kHz anyway.
  enabled_codecs: ["PCMU/8000", "PCMA/8000"],
};

const list: any = await (await fetch("https://api.elevenlabs.io/v1/convai/phone-numbers", { headers })).json();
let existing = (Array.isArray(list) ? list : []).find((p: any) => p.label === LABEL || p.phone_number === number);
let id: string;

if (existing) {
  id = existing.phone_number_id;
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ agent_id: config.elevenlabsAgentId(), outbound_trunk_config }),
  });
  if (!r.ok) throw new Error(`PATCH failed (${r.status}): ${await r.text()}`);
  console.log("trunk number updated:", id, number);
} else {
  const r = await fetch("https://api.elevenlabs.io/v1/convai/phone-numbers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: "sip_trunk",
      phone_number: number,
      label: LABEL,
      supports_inbound: false,
      supports_outbound: true,
      agent_id: config.elevenlabsAgentId(),
      outbound_trunk_config,
    }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`POST failed (${r.status}): ${JSON.stringify(j)}`);
  id = j.phone_number_id;
  console.log("trunk number created:", id, number);
}

const envPath = new URL("../.env", import.meta.url);
let env = readFileSync(envPath, "utf8").replace(/\n?$/, "\n"); // always end with a newline before appending
env = env.match(/^ELEVENLABS_AGENT_PHONE_NUMBER_ID=.*$/m)
  ? env.replace(/^ELEVENLABS_AGENT_PHONE_NUMBER_ID=.*$/m, `ELEVENLABS_AGENT_PHONE_NUMBER_ID=${id}`)
  : env + `\nELEVENLABS_AGENT_PHONE_NUMBER_ID=${id}\n`;
env = env.match(/^TELEPHONY=.*$/m) ? env.replace(/^TELEPHONY=.*$/m, "TELEPHONY=elevenlabs") : env + "TELEPHONY=elevenlabs\n";
writeFileSync(envPath, env);
console.log("wrote ELEVENLABS_AGENT_PHONE_NUMBER_ID and TELEPHONY=elevenlabs to .env");

const d: any = await (await fetch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${id}`, { headers })).json();
console.log("assigned agent:", d.assigned_agent?.agent_name, "| outbound:", d.supports_outbound, "| address:", d.outbound_trunk?.address);
