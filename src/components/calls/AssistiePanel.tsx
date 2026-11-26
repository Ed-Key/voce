import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AssistieConsent } from "./AssistieConsent";
import { RatingRow, type Rating } from "./RatingRow";
import { canRate } from "./rating";
import "./assistie.css";

export type AssistieRoute = "assistie" | "terra";

export interface AssistieSnapshot {
  run_id: string;
  status: "off" | "waiting" | "following" | "disabled" | "expired";
  transport?: "plugin" | "worker" | "codex" | null;
  connection?: {
    id: string;
    phase: "requested" | "starting" | "connected" | "stopped";
    requested_at_ms: number;
    last_attempt_ms: number;
    attempts: number;
    claimed_at_ms: number | null;
    ready_at_ms: number | null;
  } | null;
  sharing: boolean;
  proactive: boolean;
  deadline_ms: number | null;
  startup_deadline_ms: number | null;
  version: number;
  call_id?: string | null;
  feed_error?: string | null;
  archive?: boolean;
  history_offset?: number;
  history_more?: boolean;
  question_limit?: number | null;
  questions_asked?: number | null;
  context_brief: { text: string; source: string; marker: string } | null;
  questions: { id: number; text: string; version: number; status: string }[];
  replies: {
    event_id: string;
    question_id: number | null;
    kind: string;
    version: number;
    snapshot_at_ms?: number | null;
    source_status?: "revised" | "outside_window" | "unavailable" | null;
    received_at_ms?: number | null;
    text: string;
    quotes: {
      id: string;
      text: string;
      source?: "you" | "other_audio" | null;
      start_ms?: number | null;
    }[];
  }[];
  marks?: {
    id: string;
    event_id: string | null;
    rating: "good" | "bad" | "missed";
    note: string;
    at_ms: number;
    status: "pending" | "claimed" | "saved" | "failed";
    error?: string | null;
  }[];
  reply_count?: number | null;
  you_speaking?: boolean;
  terra_working?: boolean;
  terra_working_since_ms?: number | null;
}
interface Props {
  callId?: string;
  load: () => Promise<AssistieSnapshot>;
  stop: () => Promise<AssistieSnapshot>;
  ask: (question: string) => Promise<AssistieSnapshot>;
  control: (sharing: boolean, proactive: boolean) => Promise<AssistieSnapshot>;
  connect?: (
    proactive: boolean,
    retry?: boolean,
    route?: AssistieRoute,
  ) => Promise<AssistieSnapshot>;
  onHistoryPage?: (offset: number) => void;
  rate?: (rating: Rating, eventId: string | null) => Promise<AssistieSnapshot>;
}

export function AssistiePanel({
  callId,
  load,
  stop,
  ask,
  control,
  connect,
  onHistoryPage,
  rate,
}: Props) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<AssistieSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [notchVisible, setNotchVisible] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentFailed, setConsentFailed] = useState(false);
  const [pluginPhase, setPluginPhase] = useState<string | null>(null);
  const invite = useRef<HTMLButtonElement>(null);
  const [notchError, setNotchError] = useState(false);
  const generation = useRef(0);
  const acting = useRef(false);
  useEffect(() => {
    let disposed = false;
    const subscription = listen<boolean>("assistie-notch-visible", (event) => {
      if (!disposed) setNotchVisible(event.payload);
    });
    void invoke<boolean>("assistie_notch_visible")
      .then((value) => {
        if (!disposed) setNotchVisible(value);
      })
      .catch(() => {
        if (!disposed) setNotchError(true);
      });
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: number;
    async function poll() {
      const requested = generation.current;
      try {
        if (acting.current) return;
        const value = await load();
        const plugin = await invoke<{ running: boolean; phase: string }>(
          "assistie_plugin_status",
        ).catch(() => null);
        if (!disposed && requested === generation.current)
          setPluginPhase(plugin?.running ? plugin.phase : null);
        if (callId && value.call_id !== callId)
          throw new Error("Meeting changed");
        if (!disposed && requested === generation.current) {
          setSnapshot(value);
          setError(false);
        }
      } catch {
        if (!disposed && requested === generation.current) {
          setSnapshot(null);
          setError(true);
        }
      } finally {
        if (!disposed) timer = window.setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [load, callId]);
  async function change(action: () => Promise<AssistieSnapshot>) {
    if (acting.current) return false;
    acting.current = true;
    generation.current += 1;
    setBusy(true);
    try {
      const value = await action();
      if (callId && value.call_id !== callId)
        throw new Error("Meeting changed");
      setSnapshot(value);
      setError(false);
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  function closeConsent() {
    setConsentOpen(false);
    invite.current?.focus();
  }
  async function applyConsent(
    notch: boolean,
    pointers: boolean,
    route: AssistieRoute,
  ) {
    const wasSharing = !!snapshot?.sharing;
    const ok = await change(async () => {
      const value =
        !wasSharing && connect
          ? await connect(pointers, false, route)
          : await control(true, pointers);
      if (!value.sharing) throw new Error("Meeting connection ended");
      try {
        // Connecting Terra shows the notch, so compare against what is on screen now.
        if (notch !== (await invoke<boolean>("assistie_notch_visible"))) {
          const visible = await invoke<boolean>("set_assistie_notch_visible", {
            visible: notch,
          });
          setNotchVisible(visible);
        }
        setNotchError(false);
        return value;
      } catch (failure) {
        // An initial invitation must not leave unseen sharing running after a display failure.
        if (!wasSharing) await stop();
        throw failure;
      }
    });
    setConsentFailed(!ok);
    if (ok) closeConsent();
  }
  const ended =
    snapshot?.status === "disabled" || snapshot?.status === "expired";
  const callMeeting = !!callId || !!snapshot?.call_id;
  const copy = (key: string) =>
    t(
      `calls.assistie.${callMeeting && ["privacy", "following", "expired", "empty", "endedHint", "limit"].includes(key) ? `call${key.charAt(0).toUpperCase()}${key.slice(1)}` : key}`,
    );
  const enabled = !!snapshot?.sharing && !ended;
  const connectionState = snapshot?.connection
    ? snapshot.connection.phase === "requested" &&
      Date.now() - snapshot.connection.requested_at_ms >= 30000
      ? "delayed"
      : snapshot.connection.phase
    : null;
  const pending = snapshot?.questions.some(
    (value) => value.status === "pending",
  );
  const pendingQuestion = snapshot?.questions.find(
    (value) => value.status === "pending",
  );
  const terra = snapshot?.transport === "codex";
  const lastQuestion = snapshot?.questions.slice(-1)[0];
  const failedQuestion =
    lastQuestion?.status === "failed" ? lastQuestion : undefined;
  const atLimit =
    (snapshot?.questions_asked ?? snapshot?.questions.length ?? 0) >=
    (snapshot?.question_limit ?? 4);
  const replies = snapshot?.replies.filter(
    (reply) => reply.kind === "answer" || snapshot.proactive,
  );
  const latest = replies?.slice(-1)[0];
  const earlierAnswers = replies
    ?.filter((reply) => reply.kind === "answer" && reply !== latest)
    .reverse();
  function renderReply(reply: AssistieSnapshot["replies"][number]) {
    const answered = snapshot?.questions.find(
      (q) => q.id === reply.question_id,
    );
    const earlier = reply.version < (snapshot?.version ?? 0);
    return (
      <article key={reply.event_id}>
        {answered && <p className="assistie-question">{answered.text}</p>}
        {reply.kind === "pointer" && (
          <p className="assistie-question">{t("calls.assistie.pointer")}</p>
        )}
        <p>{reply.text}</p>
        {!!reply.snapshot_at_ms && (
          <small>
            {earlier && `${t("calls.assistie.earlierContext")} · `}
            {t("calls.assistie.asOf", {
              time: new Date(reply.snapshot_at_ms).toLocaleTimeString(),
            })}
          </small>
        )}
        {reply.source_status && (
          <small className="assistie-source-notice">
            {t(`calls.assistie.sourceStatus.${reply.source_status}`)}
          </small>
        )}
        {!!reply.quotes.length && (
          <blockquote className="assistie-cite">
            <mark>{reply.quotes[0].text}</mark>
          </blockquote>
        )}
        {reply.quotes.length > 1 && (
          <details>
            <summary>
              {t("calls.notch.moreSources", { count: reply.quotes.length - 1 })}
            </summary>
            {reply.quotes.slice(1).map((quote) => (
              <blockquote key={quote.id}>
                <mark>{quote.text}</mark>
              </blockquote>
            ))}
          </details>
        )}
        {rate && canRate(snapshot) && (
          <RatingRow
            marks={snapshot?.marks}
            reply={reply}
            withMissed={reply === latest}
            busy={busy}
            onRate={(rating, eventId) => change(() => rate(rating, eventId))}
          />
        )}
      </article>
    );
  }
  const canAsk = enabled && !pending && !busy && !!question.trim() && !atLimit;
  return (
    <aside className="assistie-panel" aria-labelledby="assistie-panel-title">
      <header>
        <h2 id="assistie-panel-title">
          {t(`calls.assistie.${snapshot?.archive ? "savedTitle" : "title"}`)}
        </h2>
        <span role="status">
          {snapshot?.archive
            ? t("calls.assistie.savedStatus")
            : error
              ? copy("unavailable")
              : connectionState
                ? t(
                    `calls.assistie.${terra ? "terraStates" : "connectStates"}.${connectionState}`,
                  )
                : copy(snapshot?.status ?? "waiting")}
        </span>
      </header>
      <p className="assistie-privacy">
        {snapshot?.archive
          ? t("calls.assistie.savedPrivacy")
          : terra
            ? t("calls.consent.terraPrivacy")
            : copy("privacy")}
      </p>
      {snapshot?.feed_error && (
        <p role="alert">
          {terra ? snapshot.feed_error : t("calls.assistie.feedStopped")}
        </p>
      )}
      {!snapshot?.archive && (
        <div className="assistie-invite-row">
          <button
            ref={invite}
            disabled={!snapshot || ended || busy || error}
            onClick={() => {
              setConsentFailed(false);
              setConsentOpen(true);
            }}
          >
            {t(`calls.consent.${enabled ? "settings" : "invite"}`)}
          </button>
          {notchVisible && (
            <button
              onClick={() => {
                void invoke("edit_assistie_notch", { editing: true }).catch(
                  () => setNotchError(true),
                );
              }}
            >
              {t("calls.notch.focus")}
            </button>
          )}
          {enabled && (
            <small>
              {terra && `${t("calls.assistie.routeTerra")} · `}
              {t(
                `calls.consent.${snapshot?.proactive ? "pointersEnabled" : "pointersDisabled"}`,
              )}
            </small>
          )}
        </div>
      )}
      {consentOpen && !ended && (
        <AssistieConsent
          callMeeting={callMeeting}
          active={enabled}
          notchVisible={notchVisible}
          proactive={snapshot?.proactive ?? false}
          terra={terra}
          canChooseRoute={!!connect}
          busy={busy}
          failed={consentFailed}
          onClose={closeConsent}
          onStop={() =>
            void change(stop).then((ok) => {
              if (ok) closeConsent();
            })
          }
          onAllow={(notch, pointers, route) =>
            void applyConsent(notch, pointers, route)
          }
        />
      )}
      {notchError && <p role="alert">{t("calls.notch.unavailableHelp")}</p>}
      <div
        className="assistie-replies"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {enabled && snapshot?.transport === "plugin" && (
          <p role="status">
            {t(`calls.plugin.states.${pluginPhase ?? "offline"}`, {
              defaultValue: t("calls.plugin.states.offline"),
            })}
          </p>
        )}
        {enabled &&
          !terra &&
          snapshot?.connection &&
          connectionState !== "connected" && (
            <div className="assistie-connection">
              <p role="status">
                {t(`calls.assistie.connectHelp.${connectionState}`)}
              </p>
              {connect &&
                !terra &&
                snapshot.connection.attempts < 3 &&
                Date.now() - snapshot.connection.last_attempt_ms >= 30000 && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void change(() => connect(snapshot.proactive, true))
                    }
                  >
                    {t("calls.assistie.retryConnection")}
                  </button>
                )}
            </div>
          )}
        {pendingQuestion && enabled && (
          <article>
            <p className="assistie-question">{pendingQuestion.text}</p>
            <p>
              {t(`calls.assistie.${terra ? "queuedHintTerra" : "queuedHint"}`)}
            </p>
          </article>
        )}
        {failedQuestion && enabled && (
          <article>
            <p className="assistie-question">{failedQuestion.text}</p>
            <p role="status">{t("calls.assistie.failedQuestion")}</p>
          </article>
        )}
        {latest
          ? renderReply(latest)
          : !pendingQuestion && (
              <p className="assistie-empty">
                {snapshot?.archive
                  ? t("calls.assistie.savedEmpty")
                  : copy(
                      error
                        ? "retry"
                        : ended
                          ? "endedHint"
                          : enabled
                            ? "connectedHint"
                            : "empty",
                    )}
              </p>
            )}
        {!!earlierAnswers?.length && (
          <details className="assistie-history">
            <summary>
              {t("calls.assistie.earlierAnswers", {
                count: earlierAnswers.length,
              })}
            </summary>
            {earlierAnswers.map(renderReply)}
          </details>
        )}
        {snapshot?.archive && onHistoryPage && (
          <div className="assistie-invite-row">
            <button
              disabled={!snapshot.history_offset}
              onClick={() =>
                onHistoryPage(Math.max(0, (snapshot.history_offset ?? 0) - 4))
              }
            >
              {t("calls.assistie.newerAnswers")}
            </button>
            <button
              disabled={!snapshot.history_more}
              onClick={() => onHistoryPage((snapshot.history_offset ?? 0) + 4)}
            >
              {t("calls.assistie.olderAnswers")}
            </button>
          </div>
        )}
        {snapshot?.context_brief && (
          <details className="assistie-context">
            <summary>{t("calls.assistie.context")}</summary>
            <p>{snapshot.context_brief.text}</p>
            <small>
              {t("calls.assistie.contextSource", {
                source: snapshot.context_brief.source,
              })}
            </small>
          </details>
        )}
      </div>
      {!snapshot?.archive && (
        <form
          className="assistie-ask"
          onSubmit={async (event) => {
            event.preventDefault();
            if (canAsk && (await change(() => ask(question)))) setQuestion("");
          }}
        >
          <label className="sr-only" htmlFor="assistie-question">
            {t("calls.assistie.askLabel")}
          </label>
          <input
            id="assistie-question"
            value={question}
            maxLength={800}
            disabled={!enabled || busy || pending || atLimit}
            placeholder={t("calls.assistie.askLabel")}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button type="submit" disabled={!canAsk}>
            {t("calls.assistie.ask")}
          </button>
        </form>
      )}
      {(error || (pending && enabled) || (atLimit && !ended)) && (
        <p className="assistie-pending" role="status">
          {error
            ? copy("retry")
            : pending && enabled
              ? terra
                ? t("calls.assistie.answeringTerra")
                : copy("answering")
              : copy("limit")}
        </p>
      )}
      {!snapshot?.archive && (
        <footer>
          <small>
            {ended
              ? t("calls.assistie.sessionEnded")
              : snapshot?.deadline_ms
                ? t("calls.assistie.until", {
                    time: new Date(snapshot.deadline_ms).toLocaleTimeString(
                      [],
                      {
                        hour: "numeric",
                        minute: "2-digit",
                      },
                    ),
                  })
                : snapshot?.sharing
                  ? t("calls.assistie.waitingTimer")
                  : t("calls.assistie.offHint")}
          </small>
          <button
            disabled={!snapshot || ended || busy}
            onClick={() => void change(stop)}
          >
            {t("calls.assistie.stop")}
          </button>
        </footer>
      )}
    </aside>
  );
}
