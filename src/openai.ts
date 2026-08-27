import OpenAI from "openai";
import { z } from "zod";
import { config } from "./config.js";
import { EXTRACTION_SYSTEM_PROMPT } from "./prompts.js";
import type { AskHumanResult } from "./sessions.js";

const ResultSchema = z.object({
  status: z.enum(["resolved", "unresolved"]),
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  new_context: z.array(z.string()).default([]),
  unresolved_questions: z.array(z.string()).default([]),
});

let client: OpenAI | undefined;
function openai() {
  return (client ??= new OpenAI({ apiKey: config.openaiApiKey() }));
}

/** Turn a transcript into the structured result Claude receives. */
export async function extractOutcome(briefing: string, transcript: string): Promise<AskHumanResult> {
  const completion = await openai().chat.completions.create({
    model: config.extractionModel,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: `CLAUDE'S BRIEFING:\n${briefing}\n\nCALL TRANSCRIPT:\n${transcript}\n\nReturn the JSON object.`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = ResultSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error("[extract] model returned unexpected shape:", raw);
    return {
      status: "unresolved",
      summary: "The call happened but the outcome could not be extracted reliably.",
      decisions: [],
      new_context: [],
      unresolved_questions: ["Extraction failed; consider calling again."],
    };
  }
  return parsed.data;
}
