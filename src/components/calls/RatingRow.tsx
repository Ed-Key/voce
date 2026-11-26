import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Flag, ThumbsDown, ThumbsUp } from "lucide-react";
import type { AssistieSnapshot } from "./AssistiePanel";
import { markFor } from "./rating";
import "./rating.css";

export type Rating = "good" | "bad" | "missed";

interface Props {
  marks: AssistieSnapshot["marks"];
  reply: AssistieSnapshot["replies"][number];
  /** Missed marks a moment in the meeting, so only the newest reply offers it. */
  withMissed: boolean;
  busy: boolean;
  /** Resolves false when the mark was refused (Terra stopped, or too many marks still saving). */
  onRate: (rating: Rating, eventId: string | null) => Promise<boolean>;
}

/** The user's quiet marks on a Terra reply; each one saves a private case for prompt evaluation. */
export function RatingRow({ marks, reply, withMissed, busy, onRate }: Props) {
  const { t } = useTranslation();
  const [refused, setRefused] = useState(false);
  // A second click before `busy` re-renders would be refused by the shared guard, not by Terra.
  const sending = useRef(false);
  const state = markFor(marks, reply);
  const failed =
    refused || state.ratingFailed || (withMissed && state.missedFailed);
  async function rate(rating: Rating) {
    if (sending.current) return;
    sending.current = true;
    try {
      setRefused(
        !(await onRate(rating, rating === "missed" ? null : reply.event_id)),
      );
    } finally {
      sending.current = false;
    }
  }
  const buttons = [
    {
      rating: "good" as const,
      Icon: ThumbsUp,
      pressed: state.rating === "good",
    },
    {
      rating: "bad" as const,
      Icon: ThumbsDown,
      pressed: state.rating === "bad",
    },
    ...(withMissed
      ? [{ rating: "missed" as const, Icon: Flag, pressed: state.missed }]
      : []),
  ];
  return (
    <div className="terra-rate" role="group" aria-label={t("calls.rate.group")}>
      {buttons.map(({ rating, Icon, pressed }) => (
        <button
          key={rating}
          type="button"
          className="terra-rate-button"
          aria-label={t(`calls.rate.${rating}`)}
          title={t(`calls.rate.${rating}`)}
          aria-pressed={pressed}
          // aria-disabled, not disabled: a disabled button drops keyboard focus, and the
          // notch collapses when nothing inside it is focused.
          aria-disabled={busy}
          // A saved good or bad mark is final until changed; a failed one can be retried,
          // and a missed moment can be marked again.
          onClick={() =>
            !busy &&
            (!pressed || rating === "missed" || state.ratingFailed) &&
            void rate(rating)
          }
        >
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ))}
      {failed && (
        <small className="terra-rate-failed" role="status">
          {t("calls.rate.failed")}
        </small>
      )}
    </div>
  );
}
