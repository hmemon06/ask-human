import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { config } from "./config.js";

export interface OutboundCallResponse {
  success: boolean;
  message: string;
  conversation_id?: string;
  callSid?: string;
}

/**
 * Start an outbound call through ElevenLabs (SIP trunk by default, or an imported Twilio number).
 * Destination is ALWAYS config.myPhoneNumber.
 */
export async function startOutboundCall(opts: {
  briefing: string;
  sessionId: string;
}): Promise<OutboundCallResponse> {
  const endpoint =
    config.elevenlabsOutbound === "twilio"
      ? "https://api.elevenlabs.io/v1/convai/twilio/outbound-call"
      : "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call";
  const body = {
    agent_id: config.elevenlabsAgentId(),
    agent_phone_number_id: config.elevenlabsPhoneNumberId(),
    to_number: config.myPhoneNumber(),
    conversation_initiation_client_data: {
      dynamic_variables: {
        user_name: config.userName,
        claude_briefing: opts.briefing,
        session_id: opts.sessionId,
      },
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": config.elevenlabsApiKey(),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ElevenLabs outbound-call failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as OutboundCallResponse;
}

export interface TranscriptTurn {
  role: "agent" | "user" | string;
  message: string | null;
  time_in_call_secs?: number;
}

export interface PostCallEvent {
  type: "post_call_transcription" | "post_call_audio" | "call_initiation_failure" | string;
  event_timestamp: number;
  data: {
    conversation_id: string;
    status?: string;
    transcript?: TranscriptTurn[];
    analysis?: { transcript_summary?: string; call_successful?: string };
    metadata?: { call_duration_secs?: number; termination_reason?: string };
    [k: string]: unknown;
  };
}

/**
 * Verify + parse a post-call webhook. Uses the official SDK's constructEvent
 * (HMAC check + timestamp tolerance). If no secret is configured we parse
 * without verification and log loudly — fine for local dev only.
 */
export async function parseWebhook(rawBody: string, signature: string | undefined): Promise<PostCallEvent> {
  const secret = config.elevenlabsWebhookSecret;
  if (!secret) {
    console.warn("[webhook] ELEVENLABS_WEBHOOK_SECRET not set — skipping signature verification");
    return JSON.parse(rawBody) as PostCallEvent;
  }
  if (!signature) throw new Error("Missing elevenlabs-signature header");
  const client = new ElevenLabsClient({ apiKey: config.elevenlabsApiKey() });
  const event = await client.webhooks.constructEvent(rawBody, signature, secret);
  return event as unknown as PostCallEvent;
}

export function transcriptToText(turns: TranscriptTurn[] | undefined): string {
  if (!turns?.length) return "";
  return turns
    .filter((t) => t.message && t.message.trim())
    .map((t) => `${t.role === "user" ? "USER" : "AGENT"}: ${(t.message as string).trim()}`)
    .join("\n");
}
