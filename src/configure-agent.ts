/**
 * Fully configure the ElevenLabs agent via API (idempotent):
 *   name, system prompt, first message, Custom LLM (OpenAI gpt-5.4 with your key as a secret),
 *   end_call system tool, μ-law 8000 audio in/out (required for the Twilio bridge).
 *   npm run configure-agent
 * Needs ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, OPENAI_API_KEY in .env.
 */
import { config } from "./config.js";
import { VOICE_AGENT_FIRST_MESSAGE, VOICE_AGENT_SYSTEM_PROMPT } from "./prompts.js";

const agentId = config.elevenlabsAgentId();
const headers = { "xi-api-key": config.elevenlabsApiKey(), "content-type": "application/json" };
const VOICE_MODEL = process.env.VOICE_LLM_MODEL ?? "gpt-5.4";
const SECRET_NAME = "OPENAI_API_KEY";

// 1. Ensure an OPENAI_API_KEY secret exists in the workspace.
const list: any = await (await fetch("https://api.elevenlabs.io/v1/convai/secrets", { headers })).json();
let secretId: string | undefined = (list.secrets ?? []).find((s: any) => s.name === SECRET_NAME)?.secret_id;
if (!secretId) {
  const r = await fetch("https://api.elevenlabs.io/v1/convai/secrets", {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "new", name: SECRET_NAME, value: config.openaiApiKey() }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`create secret failed (${r.status}): ${JSON.stringify(j)}`);
  secretId = j.secret_id;
  console.log("created secret", SECRET_NAME);
} else {
  console.log("secret", SECRET_NAME, "already exists");
}

// 2. Conversation-initiation webhook (workspace-level + agent enable flag).
const initWebhook = {
  url: `${config.publicUrl().replace(/\/$/, "")}/webhooks/elevenlabs/init`,
  request_headers: { "x-ask-human-secret": config.initWebhookSecret },
};
{
  const r = await fetch("https://api.elevenlabs.io/v1/convai/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ conversation_initiation_client_data_webhook: initWebhook }),
  });
  if (!r.ok) throw new Error(`settings PATCH failed (${r.status}): ${await r.text()}`);
  console.log("initiation webhook →", initWebhook.url);
}

// 3. Patch the agent.
const body = {
  name: "ask-human",
  conversation_config: {
    agent: {
      first_message: VOICE_AGENT_FIRST_MESSAGE,
      prompt: {
        prompt: VOICE_AGENT_SYSTEM_PROMPT,
        llm: "custom-llm",
        custom_llm: {
          url: "https://api.openai.com/v1",
          model_id: VOICE_MODEL,
          api_key: { secret_id: secretId },
        },
        tools: [{ type: "system", name: "end_call", description: "" }],
      },
      dynamic_variables: {
        dynamic_variable_placeholders: { user_name: config.userName, claude_briefing: "(no briefing provided)", session_id: "" },
      },
    },
    tts: { agent_output_audio_format: "ulaw_8000" },
    asr: { user_input_audio_format: "ulaw_8000" },
  },
  platform_settings: {
    // SIP path: ElevenLabs asks our server for the briefing when the call connects.
    overrides: { enable_conversation_initiation_client_data_from_webhook: true },
    workspace_overrides: { conversation_initiation_client_data_webhook: initWebhook },
  },
};

const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, { method: "PATCH", headers, body: JSON.stringify(body) });
const json: any = await res.json();
if (!res.ok) throw new Error(`PATCH failed (${res.status}): ${JSON.stringify(json)}`);

const a = json.conversation_config?.agent ?? {};
console.log("name:", json.name);
console.log("llm:", a.prompt?.llm, "| custom_llm:", a.prompt?.custom_llm?.url, a.prompt?.custom_llm?.model_id);
console.log("prompt starts:", JSON.stringify((a.prompt?.prompt ?? "").slice(0, 50)));
console.log("tools:", (a.prompt?.tools ?? []).map((t: any) => t.name).join(", ") || "(none)");
console.log("tts out:", json.conversation_config?.tts?.agent_output_audio_format, "| asr in:", json.conversation_config?.asr?.user_input_audio_format);
