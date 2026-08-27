import type { Request, Response } from "express";
import { parseWebhook } from "./elevenlabs.js";
import { handlePostCallEvent } from "./calls.js";

/** Express handler for POST /webhooks/elevenlabs. Expects raw body (express.raw). */
export async function elevenlabsWebhook(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
  const sig = req.header("elevenlabs-signature") ?? undefined;

  let event;
  try {
    event = await parseWebhook(raw, sig);
  } catch (err) {
    console.error("[webhook] rejected:", (err as Error).message);
    res.status(401).send("invalid signature");
    return;
  }

  // Ack fast; ElevenLabs retries on non-2xx and we don't want duplicate processing.
  res.status(200).send("ok");
  handlePostCallEvent(event).catch((err) => console.error("[webhook] handler error:", err));
}
