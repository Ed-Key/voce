import type { AssistieSnapshot } from "../components/calls/AssistiePanel";

// The latest question failed (Terra could not answer): older replies must not stand in for it.
function failedQuestion(snapshot: AssistieSnapshot) {
  const last = snapshot.questions.slice(-1)[0];
  return last?.status === "failed" ? last : undefined;
}

export function selectableReply(snapshot: AssistieSnapshot | null) {
  if (!snapshot?.sharing || !["following", "waiting"].includes(snapshot.status))
    return undefined;
  const failed = failedQuestion(snapshot);
  return snapshot.replies
    .slice()
    .reverse()
    .find(
      (reply) =>
        (reply.version === snapshot.version ||
          (!!snapshot.call_id &&
            !!reply.snapshot_at_ms &&
            reply.version < snapshot.version)) &&
        (reply.kind === "answer" || snapshot.proactive) &&
        (!failed || reply.version > failed.version),
    );
}

export function notchPhase(snapshot: AssistieSnapshot | null, error: boolean) {
  if (error) return "unavailable";
  if (!snapshot) return "waiting";
  if (!snapshot.sharing || ["disabled", "expired"].includes(snapshot.status))
    return "stopped";
  if (snapshot.status === "waiting") return "waiting";
  if (snapshot.questions.some((q) => q.status === "pending")) return "thinking";
  if (failedQuestion(snapshot) && !selectableReply(snapshot)) return "failed";
  return "following";
}
