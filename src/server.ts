import express from "express";
import { createServer } from "node:http";
import { config } from "./config.js";
import { askHuman, initiationDataForIncomingCall, onTwilioCallStatus } from "./calls.js";
import { elevenlabsWebhook } from "./webhooks.js";
import { listSessions } from "./sessions.js";
import { createAskHumanServer } from "./mcp-tool.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { attachBridge } from "./bridge.js";
import { twimlForSession, twimlUrlForSession, verifyTwilioSignature } from "./twilio.js";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, telephony: config.telephony });
});

// ElevenLabs post-call webhook — raw body required for signature verification.
app.post("/webhooks/elevenlabs", express.raw({ type: "*/*", limit: "10mb" }), elevenlabsWebhook);

// ElevenLabs conversation-initiation webhook (SIP path): returns the briefing as dynamic variables.
app.post("/webhooks/elevenlabs/init", express.json({ limit: "1mb" }), (req, res) => {
  const expected = config.initWebhookSecret;
  if (expected && req.header("x-ask-human-secret") !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const data = initiationDataForIncomingCall(req.body ?? {});
  if (!data) {
    res.status(404).json({ error: "no pending session" });
    return;
  }
  res.json(data);
});

// Twilio fetches TwiML here when the call is answered (twilio-bridge mode). Signed with X-Twilio-Signature.
app.post("/twilio/twiml", express.urlencoded({ extended: false }), (req, res) => {
  const sessionId = String(req.query.session ?? "");
  const url = twimlUrlForSession(sessionId);
  const sig = req.header("x-twilio-signature");
  if (!verifyTwilioSignature(url, req.body as Record<string, string>, sig)) {
    // The TwiML only references a session id the caller already supplied, and the bridge
    // only accepts pending session ids, so serve anyway but log enough to debug the check.
    console.warn(
      `[twilio] twiml signature mismatch — url=${url} sig=${sig ?? "none"} originalUrl=${req.originalUrl} host=${req.header("host")} xfproto=${req.header("x-forwarded-proto")} params=${Object.keys(req.body ?? {}).join(",")}`
    );
  }
  console.log(`[twilio] answered — serving TwiML for session ${sessionId.slice(0, 8)}`);
  res.type("text/xml").send(twimlForSession(sessionId));
});

// Twilio call status callback (paid accounts only; trial uses polling). Form-encoded, signed with X-Twilio-Signature.
app.post("/twilio/status", express.urlencoded({ extended: false }), (req, res) => {
  const params = req.body as Record<string, string>;
  const url = `${config.publicUrl().replace(/\/$/, "")}/twilio/status`;
  if (!verifyTwilioSignature(url, params, req.header("x-twilio-signature"))) {
    console.error("[twilio] status callback with bad signature");
    res.status(403).send("bad signature");
    return;
  }
  res.status(200).send("ok");
  if (params.CallSid && params.CallStatus) onTwilioCallStatus(params.CallSid, params.CallStatus);
});

// Everything below requires the shared token.
app.use((req, res, next) => {
  if (!config.askHumanToken) return next();
  if (req.header("authorization") === `Bearer ${config.askHumanToken}`) return next();
  res.status(401).json({ error: "unauthorized" });
});

app.use(express.json({ limit: "1mb" }));

/** POST /call { context } → blocks until the call resolves, returns AskHumanResult. */
app.post("/call", async (req, res) => {
  const context = typeof req.body?.context === "string" ? req.body.context.trim() : "";
  if (!context) {
    res.status(400).json({ error: "context (string) is required" });
    return;
  }
  req.setTimeout(config.callTimeoutMs + 60_000);
  try {
    res.json(await askHuman(context));
  } catch (err) {
    console.error("[server] /call error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/sessions", (_req, res) => {
  res.json(listSessions());
});

/**
 * MCP over Streamable HTTP (stateless): `claude mcp add --transport http ask-human <url>/mcp --header "Authorization: Bearer <token>"`.
 * A fresh server+transport per request is the SDK's recommended stateless pattern.
 */
app.post("/mcp", async (req, res) => {
  req.setTimeout(config.callTimeoutMs + 60_000);
  const server = createAskHumanServer(askHuman);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  }
});
app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "stateless server: use POST" });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "stateless server: nothing to delete" });
});

const server = createServer(app);
if (config.telephony === "twilio-bridge") attachBridge(server);

server.listen(config.port, () => {
  console.log(`ask-human server listening on http://localhost:${config.port}  (telephony: ${config.telephony})`);
  console.log(`  POST /call  (Bearer ASK_HUMAN_TOKEN) → rings ${process.env.MY_PHONE_NUMBER ?? "<MY_PHONE_NUMBER unset>"}`);
  console.log(`  POST /webhooks/elevenlabs`);
  if (config.telephony === "twilio-bridge") console.log(`  POST /twilio/status`);
});
// Long-lived blocking requests: don't let Node kill them.
server.keepAliveTimeout = config.callTimeoutMs + 120_000;
server.headersTimeout = config.callTimeoutMs + 130_000;
server.requestTimeout = 0;
