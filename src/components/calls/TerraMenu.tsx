import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";
import type { AssistieSnapshot } from "./AssistiePanel";

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="terra-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    />
  );
}

/** Terra's controls for the call in progress. Turning Terra on is the consent to share recent lines. */
export function TerraMenu({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<AssistieSnapshot | null>(null);
  const [wantPointers, setWantPointers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [question, setQuestion] = useState("");
  const run = useRef<string | null>(null);
  const acting = useRef(false);
  const generation = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    async function poll() {
      try {
        if (acting.current) return;
        const requested = generation.current;
        // Reading only: a connection is created when Terra is turned on, never by opening a call.
        const value = await invoke<AssistieSnapshot>(
          "assistie_fixture_snapshot",
          { runId: null },
        );
        if (disposed || requested !== generation.current) return;
        const own = value.call_id === sessionId;
        run.current = own ? value.run_id : null;
        setSnapshot(own ? value : null);
      } catch {
        // No connection yet, or a busy helper; the next poll tries again.
      } finally {
        if (!disposed) timer = window.setTimeout(() => void poll(), 1000);
      }
    }
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  async function act(action: () => Promise<AssistieSnapshot>) {
    if (acting.current) return false;
    acting.current = true;
    generation.current += 1;
    setBusy(true);
    setFailed(false);
    try {
      setSnapshot(await action());
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  const turnOn = () =>
    act(async () => {
      // A stopped connection cannot restart, so this hands back a fresh one when it has to.
      const fresh = await invoke<AssistieSnapshot>("create_call_assistie", {
        sessionId,
      });
      run.current = fresh.run_id;
      // Connecting again would restart a helper that is already running.
      if (fresh.sharing) return fresh;
      return invoke<AssistieSnapshot>("connect_terra_meeting", {
        runId: fresh.run_id,
        proactive: wantPointers,
      });
    });
  const turnOff = () =>
    act(() =>
      invoke<AssistieSnapshot>("stop_assistie_fixture", { runId: run.current }),
    );
  const setPointers = (proactive: boolean) =>
    act(async () => {
      const value = await invoke<AssistieSnapshot>("control_assistie_fixture", {
        runId: run.current,
        sharing: true,
        proactive,
      });
      setWantPointers(proactive);
      return value;
    });

  const on =
    !!snapshot?.sharing &&
    snapshot.status !== "disabled" &&
    snapshot.status !== "expired";
  const starting =
    on && !!snapshot?.connection && snapshot.connection.phase !== "connected";
  const pending = snapshot?.questions.some((q) => q.status === "pending");
  const atLimit =
    (snapshot?.questions_asked ?? snapshot?.questions.length ?? 0) >=
    (snapshot?.question_limit ?? 4);
  const last = snapshot?.questions.slice(-1)[0];
  const answer = snapshot?.replies.find(
    (reply) => reply.kind === "answer" && reply.question_id === last?.id,
  );
  const canAsk = on && !pending && !busy && !atLimit && !!question.trim();
  const pill = starting || (busy && !on) ? "starting" : on ? "on" : "off";

  return (
    <div
      className="terra-menu-box"
      ref={box}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <button
        ref={toggle}
        className={`icon-btn terra-pill ${on ? "on" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles />
        {t(`calls.terraMenu.pill.${pill}`)}
      </button>
      {open && (
        <div
          className="terra-menu"
          role="dialog"
          aria-label={t("calls.terraMenu.title")}
        >
          <div className="terra-menu-head">
            <h2>{t("calls.terraMenu.title")}</h2>
            <button
              className="icon-btn"
              aria-label={t("calls.terraMenu.close")}
              title={t("calls.terraMenu.close")}
              onClick={() => {
                setOpen(false);
                toggle.current?.focus();
              }}
            >
              <X />
            </button>
          </div>
          <div className="terra-menu-row">
            <div>
              <strong>{t("calls.terraMenu.forCall")}</strong>
              <small>{t("calls.terraMenu.forCallHelp")}</small>
            </div>
            <Switch
              label={t("calls.terraMenu.forCall")}
              checked={on}
              disabled={busy}
              onChange={() => void (on ? turnOff() : turnOn())}
            />
          </div>
          <hr />
          <div className={`terra-menu-row ${on ? "" : "dim"}`}>
            <div>
              <strong>{t("calls.terraMenu.pointers")}</strong>
              <small>{t("calls.terraMenu.pointersHelp")}</small>
            </div>
            <Switch
              label={t("calls.terraMenu.pointers")}
              checked={on && !!snapshot?.proactive}
              disabled={!on || busy}
              onChange={() => void setPointers(!snapshot?.proactive)}
            />
          </div>
          {on && (
            <form
              className="terra-menu-ask"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canAsk) return;
                void act(() =>
                  invoke<AssistieSnapshot>("ask_assistie_fixture", {
                    runId: run.current,
                    question,
                  }),
                ).then((ok) => {
                  if (ok) setQuestion("");
                });
              }}
            >
              <input
                value={question}
                maxLength={800}
                disabled={busy || pending || atLimit}
                aria-label={t("calls.terraMenu.ask")}
                placeholder={t("calls.terraMenu.ask")}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </form>
          )}
          {on && pending && (
            <p role="status">{t("calls.assistie.answeringTerra")}</p>
          )}
          {on && atLimit && (
            <p role="status">{t("calls.assistie.callLimit")}</p>
          )}
          {on && last?.status === "failed" && (
            <p role="alert">{t("calls.assistie.failedQuestion")}</p>
          )}
          {on && answer && (
            <div className="terra-menu-answer">
              <p>{answer.text}</p>
              {answer.source_status && (
                <small>
                  {t(`calls.assistie.sourceStatus.${answer.source_status}`)}
                </small>
              )}
            </div>
          )}
          {snapshot?.feed_error && <p role="alert">{snapshot.feed_error}</p>}
          {failed && <p role="alert">{t("calls.terraMenu.failed")}</p>}
          <small>{t("calls.terraMenu.privacy")}</small>
        </div>
      )}
    </div>
  );
}
