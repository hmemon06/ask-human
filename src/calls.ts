import dotenv from "dotenv";
import { config } from "./config.js";
import { startOutboundCall, transcriptToText, type PostCallEvent } from "./elevenlabs.js";
import { getCallStatus, startTwilioCall } from "./twilio.js";
import { extractOutcome } from "./openai.js";
import {
  attachConversation,
  createSession,
  getLatestCallingSession,
  getSession,
  getSessionByCallSid,
  getSessionByConversation,
  type AskHumanResult,
  type Session,
} from "./sessions.js";

const UNAVAILABLE: AskHumanResult = {
  status: "unavailable",
  summary: "The user did not answer or the call could not be completed.",
  decisions: [],
  new_context: [],
  unresolved_questions: [],
};

/** How long after the phone call ends we keep waiting for the ElevenLabs post-call webhook. */
const POST_CALL_GRACE_MS = 90_000;

/** The whole product: call the user with `context`, block until we have an outcome. */
export async function askHuman(context: string): Promise<AskHumanResult> {
  dotenv.config({ override: true, quiet: true }); // pick up .env edits (trunk ids etc.) without a restart
  const session = createSession(context);
  console.log(`[call] session ${session.id} created (telephony: ${config.telephony})`);

  try {
    if (config.telephony === "twilio-bridge") {
      const { callSid } = await startTwilioCall(session.id);
      session.callSid = callSid;
      session.status = "calling";
      console.log(`[call] ringing via Twilio — callSid ${callSid}`);
      pollTwilioStatus(session, callSid);
    } else {
      const res = await startOutboundCall({ briefing: context, sessionId: session.id });
      if (!res.success || !res.conversation_id) {
        console.error("[call] outbound call rejected:", res);
        session.resolve({ ...UNAVAILABLE, summary: `Call could not be started: ${res.message}` });
        return session.promise;
      }
      attachConversation(session, res.conversation_id, res.callSid);
      console.log(`[call] ringing via ElevenLabs — conversation ${res.conversation_id}`);
    }
  } catch (err) {
    console.error("[call] failed to start call:", err);
    session.resolve({ ...UNAVAILABLE, summary: `Call could not be started: ${(err as Error).message}` });
    return session.promise;
  }

  const timer = setTimeout(() => {
    console.warn(`[call] session ${session.id} timed out waiting for post-call webhook`);
    session.resolve({ ...UNAVAILABLE, summary: "No call outcome was received before the timeout." });
  }, config.callTimeoutMs);

  const result = await session.promise;
  clearTimeout(timer);
  return result;
}

/** Bridge tells us the audio stream ended. If ElevenLabs never started a conversation → unavailable. */
export function onConversationEnded(sessionId: string, conversationId: string | undefined) {
  const session = getSession(sessionId);
  if (!session || session.status === "done") return;
  if (!conversationId) {
    session.resolve(UNAVAILABLE);
    return;
  }
  armGrace(session);
}

/** Trial accounts can't use StatusCallback, so poll the call resource until it reaches a terminal state. */
function pollTwilioStatus(session: Session, callSid: string) {
  const TERMINAL = ["completed", "busy", "failed", "no-answer", "canceled"];
  let last = "";
  const tick = async () => {
    if (session.status === "done") return;
    try {
      const status = await getCallStatus(callSid);
      if (status !== last) {
        last = status;
        console.log(`[twilio] call ${callSid} status ${status}`);
      }
      if (TERMINAL.includes(status)) {
        onTwilioCallStatus(callSid, status);
        return;
      }
    } catch (err) {
      console.warn("[twilio] status poll failed:", (err as Error).message);
    }
    setTimeout(tick, 4000);
  };
  setTimeout(tick, 4000);
}

/** Twilio call status (from polling, or the StatusCallback on paid accounts). */
export function onTwilioCallStatus(callSid: string, status: string) {
  const session = getSessionByCallSid(callSid);
  if (!session || session.status === "done") return;
  if (["no-answer", "busy", "failed", "canceled"].includes(status)) {
    session.resolve(UNAVAILABLE);
  } else if (status === "completed") {
    // In the SIP path we don't know the conversation id until the post-call webhook, so always
    // give the webhook a grace window; it resolves "unavailable" if nothing arrives.
    armGrace(session);
  }
}

function armGrace(session: Session) {
  if (session.graceTimer) return;
  session.graceTimer = setTimeout(() => {
    if (session.status === "done") return;
    console.warn(`[call] session ${session.id}: call ended but no post-call webhook arrived`);
    session.resolve(
      session.conversationId
        ? {
            ...UNAVAILABLE,
            status: "unresolved",
            summary: "The call happened but no transcript was received from ElevenLabs (check the post-call webhook setup).",
          }
        : UNAVAILABLE
    );
  }, POST_CALL_GRACE_MS);
}

/**
 * ElevenLabs conversation-initiation webhook (SIP path): called when the SIP leg connects,
 * before the agent speaks. We hand back the briefing as dynamic variables.
 */
export function initiationDataForIncomingCall(info: { caller_id?: string; called_number?: string; call_sid?: string }) {
  const session = getLatestCallingSession();
  if (!session) {
    console.warn("[init] ElevenLabs asked for initiation data but no session is calling", info);
    return undefined;
  }
  console.log(`[init] handing briefing for session ${session.id.slice(0, 8)} to ElevenLabs (call_sid ${info.call_sid ?? "?"})`);
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: {
      user_name: config.userName,
      claude_briefing: session.context,
      session_id: session.id,
    },
  };
}

/** Called by the webhook handler for every ElevenLabs post-call event. */
export async function handlePostCallEvent(event: PostCallEvent) {
  let session = getSessionByConversation(event.data.conversation_id);
  if (!session) {
    // SIP path: we never learned the conversation id up front; match on the session_id dynamic variable.
    const sid = (event.data as any).conversation_initiation_client_data?.dynamic_variables?.session_id as string | undefined;
    if (sid) session = getSession(sid);
    if (!session) session = getLatestCallingSession();
    if (session) attachConversation(session, event.data.conversation_id, session.callSid);
  }
  if (!session) {
    console.log(`[webhook] no session for conversation ${event.data.conversation_id} (type ${event.type}) — ignoring`);
    return;
  }
  if (session.status === "done") return;

  if (event.type === "call_initiation_failure") {
    session.resolve({ ...UNAVAILABLE, summary: "The call could not be connected." });
    return;
  }
  if (event.type !== "post_call_transcription") return; // e.g. post_call_audio — ignore

  const transcript = transcriptToText(event.data.transcript);
  const userSpoke = (event.data.transcript ?? []).some((t) => t.role === "user" && t.message?.trim());

  if (!userSpoke) {
    console.log(`[webhook] session ${session.id}: no user turns (termination: ${event.data.metadata?.termination_reason}) → unavailable`);
    session.resolve(UNAVAILABLE);
    return;
  }

  console.log(`[webhook] session ${session.id}: transcript received (${event.data.metadata?.call_duration_secs}s), extracting outcome`);
  try {
    const result = await extractOutcome(session.context, transcript);
    session.resolve(result);
  } catch (err) {
    console.error("[webhook] extraction failed:", err);
    session.resolve({
      status: "unresolved",
      summary: `The call completed but outcome extraction failed: ${(err as Error).message}. ElevenLabs summary: ${event.data.analysis?.transcript_summary ?? "n/a"}`,
      decisions: [],
      new_context: [],
      unresolved_questions: [],
    });
  }
}
