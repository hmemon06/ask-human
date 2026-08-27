/**
 * Twilio Media Streams <-> ElevenLabs Agent WebSocket bridge.
 *
 * Twilio sends 8kHz μ-law base64 audio frames; the ElevenLabs agent must be
 * configured for μ-law 8000 input and output (dashboard: Voice -> output
 * format, Advanced -> input format) so we can relay bytes without transcoding.
 */
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { config } from "./config.js";
import { getSession, attachConversation } from "./sessions.js";
import { onConversationEnded } from "./calls.js";

async function getSignedUrl(): Promise<string> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(config.elevenlabsAgentId())}`,
    { headers: { "xi-api-key": config.elevenlabsApiKey() } }
  );
  if (!res.ok) throw new Error(`get-signed-url failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { signed_url: string };
  return json.signed_url;
}

export function attachBridge(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/twilio/media" });

  wss.on("connection", (twilio) => {
    let streamSid = "";
    let sessionId = "";
    let conversationId = "";
    let eleven: WebSocket | undefined;
    let lastInterrupt = -1;
    let closed = false;

    const log = (...a: unknown[]) => console.log(`[bridge${sessionId ? " " + sessionId.slice(0, 8) : ""}]`, ...a);

    const shutdown = (why: string) => {
      if (closed) return;
      closed = true;
      log("closing:", why);
      try { eleven?.close(); } catch {}
      try { twilio.close(); } catch {}
      if (sessionId) onConversationEnded(sessionId, conversationId || undefined);
    };

    const connectEleven = async () => {
      const session = getSession(sessionId);
      if (!session) {
        log("unknown session — hanging up");
        return shutdown("unknown session");
      }
      const url = await getSignedUrl();
      eleven = new WebSocket(url);

      eleven.on("open", () => {
        log("elevenlabs ws open");
        eleven!.send(
          JSON.stringify({
            type: "conversation_initiation_client_data",
            dynamic_variables: {
              user_name: config.userName,
              claude_briefing: session.context,
              session_id: sessionId,
            },
          })
        );
      });

      eleven.on("message", (data: RawData) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        switch (msg.type) {
          case "conversation_initiation_metadata":
            conversationId = msg.conversation_initiation_metadata_event.conversation_id;
            attachConversation(session, conversationId, session.callSid);
            log("conversation", conversationId);
            break;
          case "audio": {
            const ev = msg.audio_event;
            if (parseInt(ev.event_id) <= lastInterrupt) return;
            if (streamSid && twilio.readyState === WebSocket.OPEN) {
              twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: ev.audio_base_64 } }));
            }
            break;
          }
          case "interruption":
            lastInterrupt = parseInt(msg.interruption_event.event_id);
            if (streamSid && twilio.readyState === WebSocket.OPEN) {
              twilio.send(JSON.stringify({ event: "clear", streamSid }));
            }
            break;
          case "ping":
            eleven!.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
            break;
          case "agent_response":
            log("agent:", msg.agent_response_event?.agent_response?.slice(0, 120));
            break;
          case "user_transcript":
            log("user:", msg.user_transcription_event?.user_transcript?.slice(0, 120));
            break;
          default:
            break;
        }
      });

      eleven.on("close", (code) => shutdown(`elevenlabs ws closed (${code})`));
      eleven.on("error", (err) => { log("elevenlabs ws error:", err.message); shutdown("elevenlabs error"); });
    };

    twilio.on("message", (data: RawData) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          sessionId = msg.start.customParameters?.sessionId ?? "";
          log("twilio stream started", streamSid, "callSid", msg.start.callSid);
          connectEleven().catch((err) => { log("failed to connect elevenlabs:", err.message); shutdown("connect failed"); });
          break;
        case "media":
          if (eleven?.readyState === WebSocket.OPEN) {
            eleven.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
          }
          break;
        case "stop":
          shutdown("twilio stream stopped");
          break;
        default:
          break;
      }
    });

    twilio.on("close", () => shutdown("twilio ws closed"));
    twilio.on("error", (err) => { log("twilio ws error:", err.message); shutdown("twilio error"); });
  });

  console.log("  WS   /twilio/media  (Twilio <-> ElevenLabs bridge)");
}
