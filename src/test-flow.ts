/**
 * In-process test of session → post-call event → extraction, no network except OpenAI.
 *   npm run test:flow
 * With a dummy OPENAI_API_KEY you should see the graceful "unresolved" fallback;
 * with a real key you should see a proper resolved result.
 */
import { createSession, attachConversation } from "./sessions.js";
import { handlePostCallEvent } from "./calls.js";

const s = createSession("I'm building 30 SEO articles for Everbook. Profession-first vs workflow-first? I lean profession-first.");
attachConversation(s, "conv_flow_test", "CA123");

await handlePostCallEvent({
  type: "post_call_transcription",
  event_timestamp: 0,
  data: {
    conversation_id: "conv_flow_test",
    transcript: [
      { role: "agent", message: "Want the quick version?" },
      { role: "user", message: "Do a hybrid: five profession posts first, venues first, rest workflow. Worried about repetitive content." },
      { role: "agent", message: "Confirming: hybrid, five profession-specific starting with venues, rest workflow. Correct?" },
      { role: "user", message: "Yep." },
    ],
    metadata: { call_duration_secs: 60, termination_reason: "agent ended call" },
  },
});
console.log(JSON.stringify(await s.promise, null, 2));

// No-answer path
const s2 = createSession("Second test briefing with enough text.");
attachConversation(s2, "conv_noanswer");
await handlePostCallEvent({
  type: "post_call_transcription",
  event_timestamp: 0,
  data: { conversation_id: "conv_noanswer", transcript: [{ role: "agent", message: "Hey Haroon..." }], metadata: { termination_reason: "voicemail" } },
});
console.log(JSON.stringify(await s2.promise));
