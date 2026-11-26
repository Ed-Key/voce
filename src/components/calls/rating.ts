import type { AssistieSnapshot } from "./AssistiePanel";

type Marks = AssistieSnapshot["marks"];
type Reply = Pick<
  AssistieSnapshot["replies"][number],
  "event_id" | "snapshot_at_ms"
>;

/** The user's mark state for one reply: the latest good/bad on it, and a missed moment after its context.
 * Failures stay separate: a failed missed moment says nothing about this reply's own rating. */
export function markFor(marks: Marks, reply: Reply) {
  const rated = marks
    ?.filter((m) => m.event_id === reply.event_id)
    .slice(-1)[0];
  const missed = marks
    ?.filter(
      (m) => m.rating === "missed" && m.at_ms >= (reply.snapshot_at_ms ?? 0),
    )
    .slice(-1)[0];
  return {
    rating: (rated?.rating as "good" | "bad" | undefined) ?? null,
    missed: !!missed,
    ratingFailed: rated?.status === "failed",
    missedFailed: missed?.status === "failed",
  };
}

/** The bridge accepts marks only while Terra itself is following a live meeting. */
export function canRate(snapshot: AssistieSnapshot | null) {
  return (
    !!snapshot &&
    snapshot.transport === "codex" &&
    snapshot.sharing &&
    !snapshot.archive &&
    ["waiting", "following"].includes(snapshot.status)
  );
}
