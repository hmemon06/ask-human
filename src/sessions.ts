import { randomUUID } from "node:crypto";

export type AskHumanStatus = "resolved" | "unresolved" | "unavailable";

export interface AskHumanResult {
  status: AskHumanStatus;
  summary: string;
  decisions: string[];
  new_context: string[];
  unresolved_questions: string[];
}

export interface Session {
  id: string;
  context: string;
  createdAt: number;
  conversationId?: string;
  callSid?: string;
  status: "pending" | "calling" | "done";
  result?: AskHumanResult;
  graceTimer?: NodeJS.Timeout;
  resolve: (r: AskHumanResult) => void;
  promise: Promise<AskHumanResult>;
}

const sessions = new Map<string, Session>();
const byConversation = new Map<string, string>();

export function createSession(context: string): Session {
  let resolve!: (r: AskHumanResult) => void;
  const promise = new Promise<AskHumanResult>((res) => (resolve = res));
  const s: Session = {
    id: randomUUID(),
    context,
    createdAt: Date.now(),
    status: "pending",
    resolve: (r) => {
      if (s.status === "done") return;
      s.status = "done";
      s.result = r;
      if (s.graceTimer) clearTimeout(s.graceTimer);
      resolve(r);
    },
    promise,
  };
  sessions.set(s.id, s);
  return s;
}

export function attachConversation(session: Session, conversationId: string, callSid?: string) {
  session.conversationId = conversationId;
  if (callSid) session.callSid = callSid;
  session.status = "calling";
  byConversation.set(conversationId, session.id);
}

export function getSession(id: string) {
  return sessions.get(id);
}

export function getSessionByConversation(conversationId: string) {
  const id = byConversation.get(conversationId);
  return id ? sessions.get(id) : undefined;
}

export function getSessionByCallSid(callSid: string) {
  for (const s of sessions.values()) if (s.callSid === callSid) return s;
  return undefined;
}

/** Most recent session that is waiting for a call to connect (single-user V1 heuristic). */
export function getLatestCallingSession() {
  let best: Session | undefined;
  for (const s of sessions.values()) {
    if (s.status === "calling" && (!best || s.createdAt > best.createdAt)) best = s;
  }
  return best;
}

export function listSessions() {
  return [...sessions.values()].map(({ resolve: _r, promise: _p, graceTimer: _g, ...rest }) => rest);
}
