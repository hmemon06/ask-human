/**
 * Twilio REST helpers for the free-tier path.
 *
 * Trial accounts only accept To/From/Url on call creation (no inline Twiml, StatusCallback,
 * Timeout) and refuse <Connect><Stream> (Media Streams). What DOES work on trial is plain
 * TwiML, so we answer with <Dial><Sip> straight into ElevenLabs' SIP trunk, where the agent
 * lives. ElevenLabs then asks our /webhooks/elevenlabs/init for the briefing.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

const publicUrl = () => config.publicUrl().replace(/\/$/, "");
const authHeader = () =>
  "Basic " + Buffer.from(`${config.twilioAccountSid()}:${config.twilioAuthToken()}`).toString("base64");

/** TwiML served when the user answers. */
export function twimlForSession(sessionId: string): string {
  const xml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
  switch (process.env.TWIML_DIAG) {
    case "say":
      return xml(`<Say>Hello Haroon. This is the ask human diagnostic. Custom TwiML works on this account.</Say><Pause length="2"/>`);
    case "stream": {
      const wsUrl = publicUrl().replace(/^http/, "ws") + "/twilio/media";
      return xml(
        `<Connect><Stream url="${escapeXml(wsUrl)}"><Parameter name="sessionId" value="${escapeXml(sessionId)}"/></Stream></Connect>`
      );
    }
    default: {
      // Bridge the answered call into ElevenLabs via SIP. The trunk number is our Twilio number
      // registered in ElevenLabs as a SIP-trunk phone number assigned to the agent.
      const sipUri = `sip:${config.twilioPhoneNumber()}@${config.elevenlabsSipDomain}`;
      return xml(`<Dial answerOnBridge="true"><Sip>${escapeXml(sipUri)}</Sip></Dial>`);
    }
  }
}

export function twimlUrlForSession(sessionId: string): string {
  return `${publicUrl()}/twilio/twiml?session=${encodeURIComponent(sessionId)}`;
}

/** Dial MY_PHONE_NUMBER; when answered, Twilio fetches TwiML from us. */
export async function startTwilioCall(sessionId: string): Promise<{ callSid: string }> {
  const form = new URLSearchParams({
    To: config.myPhoneNumber(),
    From: config.twilioPhoneNumber(),
    Url: twimlUrlForSession(sessionId),
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid()}/Calls.json`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twilio call failed (${res.status}): ${text}`);
  return { callSid: (JSON.parse(text) as { sid: string }).sid };
}

/** queued | ringing | in-progress | completed | busy | failed | no-answer | canceled */
export async function getCallStatus(callSid: string): Promise<string> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid()}/Calls/${callSid}.json`,
    { headers: { Authorization: authHeader() } }
  );
  if (!res.ok) throw new Error(`Twilio call status failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { status: string }).status;
}

/** Validate X-Twilio-Signature: HMAC-SHA1(authToken, fullUrl + sorted(key+value of POST params)). */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", config.twilioAuthToken()).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
