import React, { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, CircleAlert, LoaderCircle, RotateCw } from "lucide-react";
import { useModelStore } from "@/stores/modelStore";
import { useSettings } from "@/hooks/useSettings";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import { ShortcutInput } from "../settings/ShortcutInput";
import { KeyCaps } from "../ui/KeyCaps";
import { api, type ShortcutFailure, type TryEvent } from "./api";
import { BackButton, Frame, I, mb, type StepProps } from "./Frame";

type State =
  | "ready"
  | "listening"
  | "transcribing"
  | "done"
  | "no_speech"
  | "failed"
  | "lost"
  | "shortcut";

interface Props extends StepProps {
  step: number;
  /** Speech model still downloading or waiting to load, if any. */
  pending: string | null;
  modelError: boolean;
  onRetryModel: () => void;
  onPickModel: () => void;
}

// After the overlay closes, wait this long for the practice text (cleanup
// can still be running) before saying it went wrong.
const TEXT_GRACE_MS = 5000;

/** The recording slip's hand mark (src/overlay), as the mockup draws it. */
export const SlipMark: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M11.85 18.04L4.65 14.05A1.31 1.31 0 0 0 3.39 16.34L10.58 20.33A1.31 1.31 0 0 0 11.85 18.04ZM7.84 12.96L6.01 7.65A1.31 1.31 0 0 0 3.54 8.5L5.37 13.81A1.31 1.31 0 0 0 7.84 12.96ZM12.11 12.62L10.3 3.31A1.31 1.31 0 0 0 7.74 3.81L9.55 13.12A1.31 1.31 0 0 0 12.11 12.62ZM16.36 12.28L15.96 4.5A1.31 1.31 0 0 0 13.35 4.64L13.75 12.42A1.31 1.31 0 0 0 16.36 12.28ZM20.59 11.94L20.97 7.56A1.31 1.31 0 0 0 18.37 7.33L17.98 11.72A1.31 1.31 0 0 0 20.59 11.94ZM9.36 21.73L18.63 20.59A3.02 3.02 0 0 0 17.89 14.58L8.62 15.72A3.02 3.02 0 0 0 9.36 21.73Z"
    />
  </svg>
);

const TryIt: React.FC<Props> = ({
  step,
  onNext,
  onBack,
  pending,
  modelError,
  onRetryModel,
  onPickModel,
}) => {
  const { t } = useTranslation();
  const [state, setStateRaw] = useState<State>("ready");
  const [text, setText] = useState("");
  const [live, setLive] = useState({ committed: "", tentative: "" });
  const [pasteMs, setPasteMs] = useState(0);
  const [focused, setFocused] = useState(false);
  const pad = useRef<HTMLTextAreaElement>(null);
  // Events can arrive faster than renders; the ref is always current.
  const stateRef = useRef<State>("ready");
  const setState = (s: State) => {
    stateRef.current = s;
    setStateRaw(s);
  };
  const releasedAt = useRef(0);
  const graceTimer = useRef<ReturnType<typeof setTimeout>>();
  const [failed, setFailed] = useState<ShortcutFailure[]>([]);
  const { settings } = useSettings();

  // Practice mode on, shortcuts registered; a taken shortcut is named (row 21).
  const begin = async () => {
    try {
      const { failedShortcuts } = await api.startTry();
      setFailed(failedShortcuts);
      if (stateRef.current === "shortcut") setState("ready");
    } catch (e) {
      console.warn("Starting the shortcut:", e);
      setFailed([]);
      setState("shortcut");
    }
  };
  // A changed key combination is registered at once; check again.
  const failedBinding = failed[0]
    ? settings?.bindings?.[failed[0].id]?.current_binding
    : undefined;
  useEffect(() => {
    if (failed[0] && failedBinding && failedBinding !== failed[0].binding)
      begin();
  }, [failedBinding]);

  const {
    models,
    downloadingModels,
    verifyingModels,
    extractingModels,
    downloadProgress,
    downloadModel,
  } = useModelStore();
  const pendingModel = pending ? models.find((m) => m.id === pending) : null;
  const finishing =
    !!pending &&
    (pending in downloadingModels ||
      pending in verifyingModels ||
      pending in extractingModels);
  const downloadFailed =
    !!pendingModel && !finishing && !pendingModel.is_downloaded;
  const modelReady = !pending && !modelError;
  const progress = pending ? downloadProgress[pending] : undefined;

  // Shortcuts and paste normally start after onboarding; Try it needs them.
  useEffect(() => {
    begin();
    let off: (() => void) | undefined;
    let alive = true;
    const onEvent = (e: TryEvent) => {
      switch (e.type) {
        case "recording":
          clearTimeout(graceTimer.current);
          setLive({ committed: "", tentative: "" });
          if (stateRef.current === "done") setText("");
          setState("listening");
          pad.current?.focus();
          break;
        case "partial":
          setLive({ committed: e.committed, tentative: e.tentative });
          break;
        case "transcribing":
          // The first sign of release counts; a second one is the same release.
          if (stateRef.current === "transcribing") break;
          releasedAt.current = performance.now();
          setState("transcribing");
          break;
        case "finished":
          if (
            stateRef.current !== "listening" &&
            stateRef.current !== "transcribing"
          )
            break;
          graceTimer.current = setTimeout(() => {
            if (
              stateRef.current === "transcribing" ||
              stateRef.current === "listening"
            )
              setState("lost");
          }, TEXT_GRACE_MS);
          break;
        case "text":
          // Practice mode: the text comes here, nothing is pasted elsewhere.
          clearTimeout(graceTimer.current);
          setText(e.text);
          setPasteMs(
            e.ms ??
              (releasedAt.current ? performance.now() - releasedAt.current : 0),
          );
          setState("done");
          break;
        case "cancelled":
          setState("ready");
          break;
        case "error":
          setState(e.error === "no_speech" ? "no_speech" : "failed");
          break;
      }
    };
    api.onTryEvent(onEvent).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
      clearTimeout(graceTimer.current);
      // Leaving ends practice mode and stops any dictation; nothing arrives
      // or pastes later (row 20b).
      api.stopTry().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (modelReady && state !== "done") pad.current?.focus();
  }, [modelReady, state]);

  // Closing the window ends practice mode (it only hides); when the window is
  // shown again on Try it, practice starts again (review N3).
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") begin();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);

  const onInput = (value: string) => {
    setText(value);
    const s = stateRef.current;
    if (
      value.trim() &&
      (s === "listening" || s === "transcribing" || s === "lost")
    ) {
      clearTimeout(graceTimer.current);
      setPasteMs(
        releasedAt.current ? performance.now() - releasedAt.current : 0,
      );
      setState("done");
    }
  };

  const again = () => {
    setText("");
    setState("ready");
    pad.current?.focus();
  };

  const done = state === "done";
  // The big caps draw Option+Space; other keys show as plain key caps.
  const binding = settings?.bindings?.transcribe?.current_binding;
  const customKeys = binding && binding !== "option+space" ? binding : null;
  const recording = state === "listening" || state === "transcribing";

  let how: React.ReactNode = null;
  if (finishing)
    how = (
      <span className="wait">
        <I icon={LoaderCircle} className="spin" />
        {progress && progress.total > 0
          ? t("onboarding.try.finishingOf", {
              done: mb(progress.downloaded),
              total: mb(progress.total),
            })
          : t("onboarding.try.finishing")}
      </span>
    );
  else if (state === "listening")
    how = (
      <Trans i18nKey="onboarding.try.listening" components={{ b: <b /> }} />
    );
  else if (state === "transcribing") how = t("onboarding.try.working");
  else if (done) how = t("onboarding.try.changeKeys");

  const problem = (title: string, action?: React.ReactNode) => (
    <div className="trouble" role="alert">
      <I icon={CircleAlert} s={18} className="ic" />
      <span>{title}</span>
      {action}
    </div>
  );
  const retry = (onClick: () => void, label = t("onboarding.try.again")) => (
    <button type="button" className="v-btn v-secondary" onClick={onClick}>
      <I icon={RotateCw} />
      {label}
    </button>
  );

  let after: React.ReactNode = null;
  if (downloadFailed)
    after = problem(
      t("onboarding.try.errors.download"),
      retry(() => pending && downloadModel(pending), t("onboarding.retry")),
    );
  else if (modelError)
    after = problem(
      t("onboarding.try.errors.model"),
      <>
        {retry(onRetryModel, t("onboarding.retry"))}
        <button type="button" className="v-btn v-ghost" onClick={onPickModel}>
          {t("onboarding.try.pickModel")}
        </button>
      </>,
    );
  else if (recording)
    after = (
      <div className="slip">
        <SlipMark size={22} />
        <span>
          {live.committed}
          {live.tentative && <span className="t"> {live.tentative}</span>}
        </span>
      </div>
    );
  else if (done)
    after = (
      <span className="ok">
        <I icon={Check} />
        {pasteMs > 0
          ? t("onboarding.try.ready", {
              time:
                pasteMs < 1000
                  ? t("onboarding.try.ms", {
                      n: Math.max(1, Math.round(pasteMs)),
                    })
                  : t("onboarding.try.s", { n: (pasteMs / 1000).toFixed(2) }),
            })
          : t("onboarding.try.readyNoTime")}
      </span>
    );
  else if (state === "no_speech")
    after = problem(t("onboarding.try.errors.noSpeech"), retry(again));
  else if (state === "failed")
    after = problem(t("onboarding.try.errors.failed"), retry(again));
  else if (state === "lost")
    after = problem(t("onboarding.try.errors.failed"), retry(again));
  else if (failed[0])
    // Another app holds the keys: say which, and change them right here.
    after = (
      <>
        {problem(
          t("onboarding.try.errors.taken", {
            keys: formatKeyCombination(failed[0].binding, "macos"),
          }),
        )}
        <div className="v-group rebind">
          <ShortcutInput
            key={failed[0].id}
            shortcutId={failed[0].id}
            hideReset
            title={
              failed[0].id === "transcribe"
                ? t("onboarding.try.newKeys")
                : undefined
            }
            description={t("onboarding.try.newKeysHint")}
          />
        </div>
      </>
    );
  else if (state === "shortcut")
    after = problem(t("onboarding.try.errors.shortcut"), retry(begin));

  return (
    <Frame
      screen="try"
      step={step}
      state={state === "listening" ? "listening" : undefined}
      className={finishing ? "finishing" : ""}
      foot={
        <>
          <BackButton onClick={onBack} />
          <span className="grow" />
          {!done && (
            <button type="button" className="v-btn v-ghost lg" onClick={onNext}>
              {t("onboarding.try.skip")}
            </button>
          )}
          <button
            type="button"
            className="v-btn v-primary lg"
            disabled={!done}
            onClick={onNext}
          >
            {t("onboarding.continue")}
          </button>
        </>
      }
    >
      <div className="hd">
        <h1>
          {done ? t("onboarding.try.doneTitle") : t("onboarding.try.title")}
        </h1>
        <p>
          {done
            ? t("onboarding.try.doneDescription")
            : t("onboarding.try.description")}
        </p>
      </div>
      {customKeys ? (
        <div className="keys">
          <KeyCaps combo={formatKeyCombination(customKeys, "macos")} />
        </div>
      ) : (
        <div className="keys" aria-label={t("onboarding.try.keysLabel")}>
          <div className="key opt">
            <span className="g">{t("onboarding.try.optionGlyph")}</span>
            <span className="w">{t("onboarding.try.option")}</span>
          </div>
          <span className="plus">{t("onboarding.try.plus")}</span>
          <div className="key sp">
            <span className="w">{t("onboarding.try.space")}</span>
          </div>
        </div>
      )}
      <div className="how">{how}</div>
      <textarea
        ref={pad}
        className={`pad ${focused && !done ? "focus" : ""}`}
        value={text}
        onChange={(e) => onInput(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={
          recording || finishing ? "" : t("onboarding.try.placeholder")
        }
        aria-label={t("onboarding.try.padLabel")}
        disabled={!modelReady}
        spellCheck={false}
      />
      <div className={`after ${failed[0] ? "tall" : ""}`}>{after}</div>
    </Frame>
  );
};

export default TryIt;
