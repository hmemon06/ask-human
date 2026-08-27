import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export type Telephony = "twilio-bridge" | "elevenlabs";

export const config = {
  openaiApiKey: () => req("OPENAI_API_KEY"),
  extractionModel: process.env.EXTRACTION_MODEL ?? "gpt-5.4",

  elevenlabsApiKey: () => req("ELEVENLABS_API_KEY"),
  elevenlabsAgentId: () => req("ELEVENLABS_AGENT_ID"),
  elevenlabsPhoneNumberId: () => req("ELEVENLABS_AGENT_PHONE_NUMBER_ID"),
  /** Which ElevenLabs outbound endpoint to use in TELEPHONY=elevenlabs mode: "sip" (Telnyx etc.) or "twilio". */
  elevenlabsOutbound: (process.env.ELEVENLABS_OUTBOUND ?? "sip") as "sip" | "twilio",
  elevenlabsWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET ?? "",
  /** Shared header value ElevenLabs sends on the conversation-initiation webhook (we configure it). */
  initWebhookSecret: process.env.ASK_HUMAN_TOKEN ?? "",

  /**
   * "twilio-bridge": we dial via Twilio REST (works on a Twilio trial) and bridge audio to ElevenLabs ourselves.
   * "elevenlabs":    ElevenLabs dials via an imported Twilio number (needs a paid Twilio account).
   */
  telephony: ((process.env.TELEPHONY as Telephony) ?? (process.env.TWILIO_ACCOUNT_SID ? "twilio-bridge" : "elevenlabs")) as Telephony,
  twilioAccountSid: () => req("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: () => req("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: () => req("TWILIO_PHONE_NUMBER"),
  /** Public https URL of this server (tunnel or host). Twilio fetches TwiML from it; ElevenLabs posts webhooks to it. */
  publicUrl: () => req("PUBLIC_URL"),
  /** ElevenLabs inbound SIP domain for SIP-trunk phone numbers. */
  elevenlabsSipDomain: process.env.ELEVENLABS_SIP_DOMAIN ?? "sip.rtc.elevenlabs.io",

  // Hard-coded destination: the tool can never dial anything else.
  myPhoneNumber: () => req("MY_PHONE_NUMBER"),
  userName: process.env.USER_NAME ?? "the user",

  port: Number(process.env.PORT ?? 3333),
  askHumanToken: process.env.ASK_HUMAN_TOKEN ?? "",
  serverUrl: process.env.ASK_HUMAN_SERVER_URL ?? "http://localhost:3333",
  callTimeoutMs: Number(process.env.CALL_TIMEOUT_MINUTES ?? 30) * 60_000,
};
