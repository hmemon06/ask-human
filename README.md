# ask-human

Claude Code works autonomously. When your judgment would materially improve the result, it calls one tool:

```ts
ask_human({ context: "..." })
```

Your phone rings. A voice agent talks it through with you. When you're done, the call ends and Claude receives a concise structured summary and keeps going.

```
Claude Code ──MCP──▶ ask_human(context)
                         │  src/mcp.ts (stdio shim)  ──HTTP──▶  src/server.ts  POST /call
                         │                                          │ ElevenLabs outbound Twilio call (dynamic vars: claude_briefing)
                         │                                          │ ElevenLabs agent ⇄ GPT-5.4 (custom LLM w/ your OpenAI key) ⇄ your phone
                         │                                          │ post-call webhook → POST /webhooks/elevenlabs (HMAC-verified)
                         │                                          │ transcript → GPT-5.4 extraction → { status, summary, decisions, ... }
                         ◀────────────────────────────────────────── blocking response
```

## Contract

```
ask_human({ context: string })
→ {
    status: "resolved" | "unresolved" | "unavailable",
    summary: string,
    decisions: string[],
    new_context: string[],
    unresolved_questions: string[]
  }
```

## Files

| file | job |
|---|---|
| `src/mcp.ts` | stdio MCP server exposing `ask_human`; forwards to `POST /call` |
| `src/server.ts` | Express: `POST /call` (blocking), `POST /webhooks/elevenlabs`, `GET /sessions`, `GET /health` |
| `src/calls.ts` | start call → wait for webhook → extract → resolve |
| `src/elevenlabs.ts` | outbound-call API (paid mode) + webhook signature verification (official SDK) |
| `src/twilio.ts` | Twilio REST dial with inline `<Connect><Stream>` TwiML + status-callback signature check |
| `src/bridge.ts` | WebSocket bridge: Twilio Media Streams ⇄ ElevenLabs agent WS (μ-law passthrough, interruptions, ping/pong) |
| `src/openai.ts` | transcript → structured outcome |
| `src/sessions.ts` | in-memory `Map<sessionId, Session>` |
| `src/prompts.ts` | voice-agent prompt (paste into ElevenLabs), extraction prompt, tool description |

## Setup (one-time)

### 1. ElevenLabs agent
1. Agents → New agent.
2. **System prompt**: paste `VOICE_AGENT_SYSTEM_PROMPT` from `src/prompts.ts`. **First message**: paste `VOICE_AGENT_FIRST_MESSAGE`. Both use `{{user_name}}` and `{{claude_briefing}}`; the agent editor will flag them as dynamic variables — leave them without defaults or set a placeholder default.
3. **LLM**: choose *Custom LLM*. Server URL `https://api.openai.com/v1`, model `gpt-5.4`, and add a secret named `OPENAI_API_KEY` with your OpenAI key. (Switch to `gpt-5.4-mini` later if you burn the allowance.)
4. **Tools**: enable the system tool **End call**.
5. Pick a voice you like and test in the browser with the widget — supply dummy values for the two variables. Confirm latency/interruptions feel good before wiring the phone.
6. Copy the agent id → `ELEVENLABS_AGENT_ID`.

7. Or skip steps 2–6 entirely: `npm run configure-agent` sets prompt, first message, Custom LLM (creates the `OPENAI_API_KEY` secret), `end_call`, μ-law 8000 audio in/out, and the initiation webhook via API — no Publish needed.

### 2. Telephony — Telnyx SIP trunk (`TELEPHONY=elevenlabs`, the working free path)
ElevenLabs dials out through a SIP trunk; Telnyx's trial credit covers it. (Twilio's trial was a dead end: it blocks `<Connect><Stream>`, `<Dial><Sip>` and number import — that code is still in `src/bridge.ts` / `src/twilio.ts` for a paid Twilio account, `TELEPHONY=twilio-bridge`.)
1. telnyx.com → verify identity → **Numbers → Buy** a US voice number.
2. **Voice → SIP Trunking → Create SIP Connection** (`ask-human`), auth type **Credentials** → copy username + password.
3. **Voice → Outbound Voice → Outbound Voice Profiles → Add** (`ask-human`, US allowed) → assign the connection.
4. Connection → **Numbers** tab → assign your number. **Numbers → Verified Numbers** → verify your mobile (trial can only call verified numbers).
5. `.env`: `SIP_TRUNK_NUMBER`, `SIP_TRUNK_ADDRESS=sip.telnyx.com`, `SIP_TRUNK_USERNAME`, `SIP_TRUNK_PASSWORD`.
6. `npm run configure-trunk` — registers the trunk number in ElevenLabs, assigns the agent, writes `ELEVENLABS_AGENT_PHONE_NUMBER_ID` and `TELEPHONY=elevenlabs`.

Gotchas learned the hard way: ElevenLabs sends the INVITE over **UDP regardless of the transport setting**, so keep `media_encryption: disabled` and the codec list short or the authenticated INVITE exceeds the MTU ("size of packet larger than MTU"). A bare `403 Forbidden` from Telnyx (no reason text) means wrong password.

### 3. Server + tunnel
```bash
cp .env.example .env   # fill it in
npm install
cloudflared tunnel --url http://localhost:3333   # or ngrok http 3333
```
Put the tunnel's `https://…` URL in `.env` as `PUBLIC_URL` (Twilio connects back to `wss://…/twilio/media` and posts call status to `/twilio/status`), then:
```bash
npm run server         # http://localhost:3333
```
Note: a quick-tunnel URL changes every restart — update `PUBLIC_URL` and the ElevenLabs webhook URL when it does.

### 4. Post-call webhook
ElevenLabs → Agents → Settings → Post-call webhooks → add `https://<tunnel>/webhooks/elevenlabs`, auth type HMAC. Copy the secret → `ELEVENLABS_WEBHOOK_SECRET`. Enable *transcription* (audio not needed). Make sure the agent has the webhook enabled in its analysis/settings tab. Restart the server after editing `.env`.

### 5. Smoke test (no Claude yet)
```bash
npm run test:call -- "I'm testing the loop. Ask Haroon whether we should ship it, confirm, hang up."
```
Your phone should ring; after you hang up the command prints the structured result.

### 6. Register with Claude Code
```bash
claude mcp add --scope user ask-human -- node C:\Users\hmemo\ask-human\node_modules\tsx\dist\cli.mjs C:\Users\hmemo\ask-human\src\mcp.ts
```
The shim reads `.env` from the project dir via `dotenv`; only `ASK_HUMAN_SERVER_URL`, `ASK_HUMAN_TOKEN`, and `CALL_TIMEOUT_MINUTES` matter to it.

**Tool timeout.** Claude Code's default MCP tool timeout is shorter than a phone call. Set it (ms) in `~/.claude/settings.json`:
```json
{ "env": { "MCP_TOOL_TIMEOUT": "2400000" } }
```
Restart Claude Code, then `/mcp` should list `ask-human` with the `ask_human` tool.

### 7. Tell Claude when to call
Put in the project's `CLAUDE.md` (or the task prompt):
```
You have an ask_human tool that phones me. Use it only when my judgment is materially useful or
before making a strategically consequential assumption. If I'm unavailable and the decision isn't
destructive/irreversible, make the most reasonable assumption, document it, and continue.
```

## Behavior notes
- Destination number is hard-coded from `MY_PHONE_NUMBER`; the tool never accepts a number.
- No answer / busy / failed (Twilio status) or no user speech → `unavailable`. Call ended but no post-call webhook within 90s → `unresolved` with a hint to check the webhook. Nothing at all within `CALL_TIMEOUT_MINUTES` → `unavailable`.
- Bridge mode: the agent's **End conversation** tool closes the ElevenLabs WS → we close the Twilio stream → Twilio hangs up.
- Webhook is acked immediately and processed async; duplicate deliveries are ignored once a session is done.
- State is in memory. Restarting the server mid-call loses the session (Claude gets a timeout → `unavailable`).

## Hosted (Render free tier) — the way it actually runs
Service `ask-human` in Render (`https://ask-human.onrender.com`, region Ohio, auto-deploys from `master`). Build `npm ci && npm run build`, start `npm start`. All `.env` keys live as Render env vars; `PUBLIC_URL=https://ask-human.onrender.com`. ElevenLabs' post-call and initiation webhooks point there (`npm run configure-webhook` / `configure-agent` with that `PUBLIC_URL`).

Claude Code talks to it over **MCP Streamable HTTP** — no local process:
```bash
claude mcp add --scope user --transport http ask-human https://ask-human.onrender.com/mcp --header "Authorization: Bearer <ASK_HUMAN_TOKEN>"
```
This works from laptop Claude Code and from cloud sessions alike. The tool handler emits an MCP log notification every 20s so the streamed response survives proxy idle timeouts during a long call.

Free-tier caveats:
- The instance sleeps after 15 min idle; the first `ask_human` after that takes ~30–60s to wake before the phone rings.
- Sessions are in memory. A deploy **during** a call kills the session (the post-call webhook then arrives at a fresh instance and is ignored). Don't push while a call is up.
- Rotating the webhook secret (`configure-webhook` after a URL change) requires updating `ELEVENLABS_WEBHOOK_SECRET` in Render's env — which itself triggers a deploy.
