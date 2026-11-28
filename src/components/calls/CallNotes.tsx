import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import "./calls.css";
import { reconcileStopped, stopThenSave } from "./stop";
import { AssistiePlugin } from "./AssistiePlugin";
import { AssistiePanel, type AssistieSnapshot } from "./AssistiePanel";
import { ChevronLeft, Info, Mic, Sparkles, Square, Trash2 } from "lucide-react";
import { CallObservatory } from "./CallObservatory";
import { TerraMenu } from "./TerraMenu";
import { type Tab, tabAfterSwitch, terraOn, visibleTabs } from "./terraGate";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { PageHeader } from "../ui/PageHeader";
import { Button } from "../ui/Button";
import { humanDuration } from "./duration";
import { dayLabel } from "@/utils/dateFormat";
import { useSettings } from "../../hooks/useSettings";
import {
  clock as replayClock,
  type ObservatoryData,
} from "./observatoryPlayer";

type CallApp = "discord" | "face_time" | "zoom" | "google_meet";
interface TrackStats {
  samples: number;
  sample_rate: number;
  error: string | null;
}
interface CallSession {
  id: string;
  title: string;
  started_at: string;
  active: boolean;
  mic_state: "stopped" | "starting" | "live" | "yielded" | "failed";
  mic_gaps: { start_ms: number; resumed_ms: number | null }[];
  detected_app: CallApp | null;
  elapsed_ms: number;
  notes: string;
  system: TrackStats;
  mic_segments: { stats: TrackStats }[];
  error: string | null;
}
interface Detection {
  available: boolean;
  apps: CallApp[];
  possible_end: boolean;
  dictating: boolean;
}
interface Entry {
  id: number;
  source: string;
  start_ms: number;
  end_ms: number;
  text: string;
}
const sections = [
  "overview",
  "decisions",
  "action_items",
  "open_questions",
] as const;
type Section = (typeof sections)[number];
interface Summary {
  job_id: string;
  transcript_version: string;
  sections: Record<Section, { text: string; sources: number[] }[]>;
  edited_text: string | null;
}
interface Analysis {
  audio: { managed: boolean; expires_at: number | null; expired: boolean };
  status: string;
  error: string | null;
  done: number;
  total: number;
  transcript: {
    complete: boolean;
    version: string;
    entries: Entry[];
    warnings: string[];
  } | null;
  summary: Summary | null;
  outdated: boolean;
}
function clock(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
const processing = (status?: string) =>
  ["queued", "running", "paused", "transcribing", "summarizing"].includes(
    status ?? "",
  );

/** Calls under their day, newest first as they already are. */
function days(calls: CallSession[], t: (key: string) => string) {
  const label = (value: CallSession) => dayLabel(new Date(value.started_at), t);
  const groups = new Map<string, CallSession[]>();
  for (const call of calls)
    groups.set(label(call), [...(groups.get(label(call)) ?? []), call]);
  return [...groups];
}

const REPLAY_SETTLE_MS = 120_000;
const REPLAY_READ_MS = 2000;

/** The small print of a page, one click away. */
function CallInfo({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node))
        box.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details className="call-info" ref={box}>
      <summary className="icon-btn" aria-label={label} title={label}>
        <Info />
      </summary>
      <div className="call-info-panel">{children}</div>
    </details>
  );
}

export function CallNotes() {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const [saved, setSaved] = useState<CallSession[]>([]);
  const [live, setLive] = useState<CallSession | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [tab, setTab] = useState<Tab>("notes");
  // Terra is experimental: its tab, controls, panels and saved replies show only while the switch is on.
  const terra = terraOn({
    experimental_enabled: getSetting("experimental_enabled"),
  });
  const tabs = visibleTabs(terra);
  const [notes, setNotes] = useState("");
  const [replay, setReplay] = useState<ObservatoryData | null>(null);
  const [replayFailed, setReplayFailed] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAssistieFixture, setShowAssistieFixture] = useState(false);
  const [assistieRun, setAssistieRun] = useState<string | null>(null);
  const [assistieCall, setAssistieCall] = useState<string | null>(null);
  const [callAssistieOpen, setCallAssistieOpen] = useState(false);
  const [assistieArchive, setAssistieArchive] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  // Switching Terra off closes whatever Terra view is open.
  useEffect(() => {
    if (terra) return;
    setTab((current) => tabAfterSwitch(current, false));
    setShowAssistieFixture(false);
    setCallAssistieOpen(false);
  }, [terra]);
  const loadAssistieFixture = useCallback(
    () =>
      assistieArchive
        ? invoke<AssistieSnapshot>("saved_call_assistie", {
            sessionId: assistieCall,
            offset: historyOffset,
          })
        : invoke<AssistieSnapshot>("assistie_fixture_snapshot", {
            runId: assistieRun,
          }),
    [assistieRun, assistieArchive, assistieCall, historyOffset],
  );
  const stopAssistieFixture = useCallback(
    () =>
      invoke<AssistieSnapshot>("stop_assistie_fixture", { runId: assistieRun }),
    [assistieRun],
  );
  const askAssistieFixture = useCallback(
    (question: string) =>
      invoke<AssistieSnapshot>("ask_assistie_fixture", {
        runId: assistieRun,
        question,
      }),
    [assistieRun],
  );
  const controlAssistieFixture = useCallback(
    (sharing: boolean, proactive: boolean) =>
      invoke<AssistieSnapshot>("control_assistie_fixture", {
        runId: assistieRun,
        sharing,
        proactive,
      }),
    [assistieRun],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editJob, setEditJob] = useState("");
  const [focus, setFocus] = useState<number | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const acting = useRef(false);
  const initialized = useRef(false);
  const session =
    (live?.active && live.id === selected
      ? live
      : saved.find((s) => s.id === selected)) ?? null;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const refresh = useCallback(async () => {
    const [archive, current, activity] = await Promise.all([
      invoke<CallSession[]>("list_saved_calls"),
      invoke<CallSession | null>("call_notes_snapshot"),
      invoke<Detection>("call_detection_snapshot"),
    ]);
    setSaved(reconcileStopped(archive, current));
    setLive(current);
    setDetection(activity);
    return { archive, current };
  }, []);
  useEffect(() => {
    let disposed = false;
    const open = async () => {
      try {
        const destination = await invoke<{
          session_id: string | null;
          assistie_run: string | null;
        } | null>("take_call_invitation_destination");
        if (!destination || disposed) return;
        if (destination.assistie_run) {
          selectedRef.current = null;
          setSelected(null);
          setAssistieRun(destination.assistie_run);
          setAssistieCall(null);
          setAssistieArchive(false);
          setCallAssistieOpen(false);
          setShowAssistieFixture(true);
        } else if (destination.session_id) {
          selectedRef.current = destination.session_id;
          setSelected(destination.session_id);
          setShowAssistieFixture(false);
          setAnalysis(null);
          setTab("transcript");
          await refresh();
        }
      } catch (failure) {
        if (!disposed) setError(String(failure));
      }
    };
    const sub = listen("call-invitation-open", () => {
      void open();
    });
    void sub.then(() => {
      if (!disposed) void open();
    });
    return () => {
      disposed = true;
      void sub.then((unlisten) => unlisten());
    };
  }, [refresh]);
  useEffect(() => {
    let disposed = false;
    let timer: number;
    const poll = async () => {
      try {
        if (!acting.current) {
          const { current } = await refresh();
          if (disposed) return;
          if (!initialized.current) {
            initialized.current = true;
            if (current?.active) {
              selectedRef.current = current.id;
              setSelected(current.id);
            }
          }
          const id = selectedRef.current;
          if (id && !current?.active) {
            const value = await invoke<Analysis>("call_analysis", {
              sessionId: id,
            });
            if (!disposed && selectedRef.current === id) setAnalysis(value);
          } else if (id && current?.id !== id) {
            const value = await invoke<Analysis>("call_analysis", {
              sessionId: id,
            });
            if (!disposed && selectedRef.current === id) setAnalysis(value);
          }
        }
      } catch (failure) {
        if (!disposed) setError(String(failure));
      } finally {
        if (!disposed) timer = window.setTimeout(poll, 1200);
      }
    };
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    setNotes(sessionRef.current?.notes ?? "");
    setEditing(false);
    setFocus(null);
  }, [selected]);
  // Serialize autosaves so an older IPC response cannot overwrite a newer edit.
  function saveNotes() {
    const value = sessionRef.current;
    const text = notesRef.current;
    if (!value) return writes.current;
    const next = writes.current
      .catch(() => {})
      .then(async () => {
        await invoke(
          value.active ? "save_call_notes" : "save_saved_call_notes",
          { sessionId: value.id, notes: text },
        );
      });
    writes.current = next;
    return next;
  }
  useEffect(() => {
    if (!session || notes === session.notes) return;
    const timer = window.setTimeout(() => {
      void saveNotes().catch((e) => setError(String(e)));
    }, 500);
    return () => window.clearTimeout(timer);
    // Only edits schedule saves; polling never replaces the local draft.
  }, [notes, selected]);
  async function choose(value: CallSession | null) {
    if (acting.current) return;
    try {
      await saveNotes();
      selectedRef.current = value?.id ?? null;
      setSelected(value?.id ?? null);
      setNotes(value?.notes ?? "");
      notesRef.current = value?.notes ?? "";
      setAnalysis(null);
      setError("");
      setTab("notes");
    } catch (e) {
      setError(String(e));
    }
  }
  async function action(command: string, args?: Record<string, unknown>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      let result: CallSession | null;
      if (command === "stop_call_notes") {
        const snapshot = sessionRef.current;
        const text = notesRef.current;
        result = await stopThenSave(
          () => invoke<CallSession | null>(command, args),
          (stopped) =>
            stopped && stopped.id === snapshot?.id
              ? invoke("save_saved_call_notes", {
                  sessionId: stopped.id,
                  notes: text,
                })
              : Promise.resolve(),
          (failure) =>
            setError(t("calls.stoppedSaveFailed", { error: String(failure) })),
        );
        setLive(result);
        if (result)
          setSaved((archive) =>
            archive.map((s) => (s.id === result!.id ? result! : s)),
          );
      } else {
        await saveNotes();
        result = await invoke<CallSession | null>(command, args);
      }
      if (command === "start_call_notes" && result) {
        selectedRef.current = result.id;
        setSelected(result.id);
        setLive(result);
        setNotes(result.notes);
        setAnalysis(null);
        setTab("notes");
      }
      await refresh();
      if (selectedRef.current && command !== "start_call_notes")
        setAnalysis(
          await invoke<Analysis>("call_analysis", {
            sessionId: selectedRef.current,
          }),
        );
      return true;
    } catch (failure) {
      setError(String(failure));
      return false;
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (focus !== null && tab === "transcript")
      document.getElementById(`passage-${focus}`)?.focus();
  }, [focus, tab]);
  const replaying = tab === "system" || tab === "terra";
  // Test runs leave fictional entries in the archive; they are not calls.
  const calls = saved.filter((value) => !value.id.startsWith("fictional-"));
  const replayId = session?.id ?? null;
  const liveCall = !!session?.active;
  const followingLogs = tab !== "notes";
  const replayJson = useRef("");
  useEffect(() => {
    replayJson.current = "";
    setReplay(null);
    setReplayFailed(false);
  }, [replayId]);
  // Reads the call's logs while it runs, and for a while after: its last lines and Terra turns land after Stop returns,
  // and short calls get no later job to trigger a refresh. One read at a time, only while a tab shows them.
  // ponytail: each read is the whole log, about 1 s at 65 minutes. A tail reader is the upgrade if it hurts a call.
  const replayEnded = session
    ? Date.parse(session.started_at) + session.elapsed_ms
    : 0;
  useEffect(() => {
    if (!replayId) return;
    let current = true;
    let timer = 0;
    const read = () =>
      invoke<string>("call_observatory", { sessionId: replayId })
        .then((json) => {
          if (!current || json === replayJson.current) return;
          replayJson.current = json;
          setReplay(JSON.parse(json) as ObservatoryData);
          setReplayFailed(false);
        })
        .catch(() => {
          if (current && !replayJson.current) setReplayFailed(true);
        })
        .finally(() => {
          if (!current || !followingLogs) return;
          if (liveCall || Date.now() < replayEnded + REPLAY_SETTLE_MS)
            timer = window.setTimeout(() => void read(), REPLAY_READ_MS);
        });
    void read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    replayId,
    liveCall,
    followingLogs,
    liveCall ? 0 : replayEnded,
    analysis?.status,
    analysis?.transcript?.version,
  ]);
  const heardEntries = replay
    ? Object.values(replay.lines)
        .flatMap((line) => {
          const last = line.revisions[line.revisions.length - 1];
          return last &&
            !(line.dropped && line.dropped.epoch_ms >= last.epoch_ms)
            ? [{ line, last }]
            : [];
        })
        .sort(
          (a, b) => (a.last.audio_ms?.[0] ?? 0) - (b.last.audio_ms?.[0] ?? 0),
        )
        .map(({ line, last }, index) => ({
          id: index + 1,
          source: line.source === "you" ? "mic" : "system",
          start_ms: last.audio_ms?.[0] ?? 0,
          end_ms: last.audio_ms?.[1] ?? 0,
          text: last.text,
        }))
    : null;
  // Short calls get no saved transcript, so what was heard stays the transcript after Stop.
  const savedEntries = analysis?.transcript?.entries;
  const entries =
    (liveCall || !savedEntries?.length ? heardEntries : savedEntries) ?? [];
  const transcriptBox = useRef<HTMLDivElement>(null);
  const followingTranscript = useRef(true);
  useEffect(() => {
    const box = transcriptBox.current;
    if (liveCall && box && followingTranscript.current)
      box.scrollTop = box.scrollHeight;
  }, [liveCall, tab, entries.length]);
  function cite(id: number) {
    setFocus(id);
    setTab("transcript");
  }
  const working = processing(analysis?.status);
  const errors = [
    error,
    session?.error,
    session?.system.error,
    ...(session?.mic_segments.map((s) => s.stats.error) ?? []),
    analysis?.error,
  ].filter(Boolean);
  const date = (value: CallSession) =>
    new Date(value.started_at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const time = (value: CallSession) =>
    new Date(value.started_at).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  const app = (value: CallSession) =>
    value.detected_app
      ? t(`calls.apps.${value.detected_app}`)
      : t("calls.localCall");
  const toggleAssistie = (value: CallSession) => {
    if (assistieCall === value.id && callAssistieOpen) {
      setCallAssistieOpen(false);
      return;
    }
    setBusy(true);
    void invoke<AssistieSnapshot>(
      value.active ? "create_call_assistie" : "saved_call_assistie",
      { sessionId: value.id, ...(!value.active ? { offset: 0 } : {}) },
    )
      .then((snapshot) => {
        setAssistieRun(snapshot.run_id);
        setAssistieCall(value.id);
        setAssistieArchive(!value.active);
        setHistoryOffset(0);
        setShowAssistieFixture(false);
        setCallAssistieOpen(true);
        setError("");
      })
      .catch((failure) => setError(String(failure)))
      .finally(() => setBusy(false));
  };
  const terraLabel = session
    ? t(
        `calls.assistie.${callAssistieOpen && assistieCall === session.id ? "closePanel" : session.active ? "open" : "savedTitle"}`,
      )
    : "";
  const assistiePanel = (
    <AssistiePanel
      key={`${assistieCall}:${assistieRun}`}
      callId={assistieCall ?? undefined}
      onHistoryPage={setHistoryOffset}
      load={loadAssistieFixture}
      stop={stopAssistieFixture}
      ask={askAssistieFixture}
      control={controlAssistieFixture}
      rate={(rating, eventId) =>
        invoke<AssistieSnapshot>("rate_terra_reply", {
          runId: assistieRun,
          eventId,
          rating,
          note: "",
        })
      }
      connect={(proactive, retry, route) =>
        retry
          ? invoke<AssistieSnapshot>("retry_assistie_connection", {
              runId: assistieRun,
            })
          : invoke<AssistieSnapshot>(
              route === "terra"
                ? "connect_terra_meeting"
                : "connect_assistie_meeting",
              { runId: assistieRun, proactive },
            )
      }
    />
  );
  return (
    <section className={session ? "call-notepad" : "call-notepad call-library"}>
      {!session ? (
        <>
          <PageHeader
            title={t("calls.library")}
            count={calls.length || undefined}
            actions={
              <>
                {!showAssistieFixture && (
                  <Button
                    disabled={busy || live?.active || detection?.dictating}
                    onClick={() => void action("start_call_notes")}
                  >
                    <Mic width={15} height={15} />
                    {t("calls.start")}
                  </Button>
                )}
                {/* .obs styles the popover contents as on the call page. */}
                <div className="obs">
                  <CallInfo label={t("calls.about")}>
                    <p>{t("calls.libraryHint")}</p>
                    <p>{t("calls.retentionPolicy")}</p>
                    <ToggleSwitch
                      checked={getSetting("call_invitations_enabled") ?? true}
                      onChange={(next) =>
                        void updateSetting("call_invitations_enabled", next)
                      }
                      isUpdating={isUpdating("call_invitations_enabled")}
                      label={t("calls.invitation.enabledLabel")}
                      description={t("calls.invitation.enabledDescription")}
                      descriptionMode="inline"
                    />
                    <p>{t("calls.detectionScope")}</p>
                    {terra && <AssistiePlugin />}
                    <div className="call-info-actions">
                      <button
                        disabled={busy || !!live?.active}
                        onClick={() => {
                          void invoke("preview_call_invitation").catch(
                            (failure) => setError(String(failure)),
                          );
                        }}
                      >
                        {t("calls.invitation.preview")}
                      </button>
                      {terra && (
                        <button
                          disabled={busy || !!live?.active}
                          onClick={() => {
                            if (showAssistieFixture) {
                              setShowAssistieFixture(false);
                              return;
                            }
                            setBusy(true);
                            void invoke<AssistieSnapshot>(
                              "create_assistie_fixture",
                            )
                              .then((value) => {
                                setAssistieRun(value.run_id);
                                setAssistieCall(null);
                                setAssistieArchive(false);
                                setCallAssistieOpen(false);
                                setShowAssistieFixture(true);
                                setError("");
                              })
                              .catch((failure) => setError(String(failure)))
                              .finally(() => setBusy(false));
                          }}
                        >
                          {t(
                            showAssistieFixture
                              ? "calls.assistie.close"
                              : "calls.assistie.fixture",
                          )}
                        </button>
                      )}
                    </div>
                  </CallInfo>
                </div>
              </>
            }
          />
          {detection?.available && !!detection.apps.length && (
            <div className="call-library-status" aria-live="polite">
              <span className="v-dot" />
              <span>
                {t("calls.detected", {
                  apps: detection.apps
                    .map((a) => t(`calls.apps.${a}`))
                    .join(", "),
                })}
              </span>
            </div>
          )}
          {terra && showAssistieFixture ? (
            assistiePanel
          ) : calls.length ? (
            days(calls, t).map(([day, calls]) => (
              <section key={day}>
                <h2 className="v-gl">{day}</h2>
                <div className="v-group">
                  {calls.map((value) => (
                    <div
                      className="call-row"
                      key={value.id}
                      onMouseLeave={() =>
                        setConfirming((id) => (id === value.id ? null : id))
                      }
                    >
                      <button
                        className="call-row-open"
                        onClick={() =>
                          void choose(
                            live?.active && live.id === value.id ? live : value,
                          )
                        }
                      >
                        <span className="call-row-title">
                          {value.title !== "Call notes"
                            ? value.title
                            : app(value)}
                        </span>
                        <span className="v-meta">
                          {value.active ? t("calls.recording") : time(value)}
                        </span>
                        <span className="call-row-length">
                          {value.active
                            ? clock(value.elapsed_ms)
                            : humanDuration(value.elapsed_ms, t)}
                        </span>
                      </button>
                      {!value.active && (
                        <button
                          className={`call-row-delete ${confirming === value.id ? "confirming" : ""}`}
                          disabled={busy}
                          aria-label={t("calls.delete")}
                          title={t("calls.delete")}
                          onBlur={() => setConfirming(null)}
                          onClick={() => {
                            if (confirming !== value.id) {
                              setConfirming(value.id);
                              return;
                            }
                            setConfirming(null);
                            void invoke("delete_call", { sessionId: value.id })
                              .then(refresh)
                              .catch((failure) => setError(String(failure)));
                          }}
                        >
                          {confirming === value.id ? (
                            t("calls.confirmDelete")
                          ) : (
                            <Trash2 />
                          )}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <p className="call-empty">{t("calls.noSaved")}</p>
          )}
        </>
      ) : (
        <>
          <div className="obs">
            <div className="top">
              <button className="crumb" onClick={() => void choose(null)}>
                <ChevronLeft />
                {t("calls.back")}
              </button>
              <div className="tools end">
                {session.active ? (
                  <>
                    {terra && (
                      <TerraMenu key={session.id} sessionId={session.id} />
                    )}
                    <button
                      className="icon-btn ask"
                      disabled={busy}
                      onClick={() => void action("stop_call_notes")}
                    >
                      <Square />
                      {t("calls.stop")}
                    </button>
                  </>
                ) : (
                  <CallInfo label={t("calls.about")}>
                    {analysis?.audio && (
                      <p>
                        {analysis.audio.expired
                          ? t("calls.audioExpired")
                          : analysis.audio.expires_at
                            ? t("calls.audioExpires", {
                                date: new Date(
                                  analysis.audio.expires_at * 1000,
                                ).toLocaleString(),
                              })
                            : t(
                                analysis.audio.managed
                                  ? "calls.audioAwaitingTranscript"
                                  : "calls.audioLegacy",
                              )}
                      </p>
                    )}
                    <p>{t("calls.captureDescription")}</p>
                    <p>
                      {t("calls.systemSamples", {
                        count: session.system.samples,
                      })}
                    </p>
                    <p>
                      {t("calls.micSamples", {
                        count: session.mic_segments.reduce(
                          (sum, s) => sum + s.stats.samples,
                          0,
                        ),
                      })}
                    </p>
                    {terra && (
                      <div className="call-info-actions">
                        <button
                          disabled={busy}
                          onClick={() => toggleAssistie(session)}
                        >
                          {terraLabel}
                        </button>
                      </div>
                    )}
                  </CallInfo>
                )}
              </div>
            </div>
            <header className="top">
              <div className="title">
                <h1>
                  {session.title !== "Call notes"
                    ? session.title
                    : app(session)}
                </h1>
                <span className={`pill ${session.active ? "" : "ended"}`}>
                  <span className="rec" />
                  {clock(session.elapsed_ms)}
                </span>
              </div>
              <div
                className="tabs"
                role="tablist"
                aria-label={t("calls.title")}
              >
                {tabs.map((value, index) => (
                  <button
                    key={value}
                    id={`call-tab-${value}`}
                    role="tab"
                    aria-selected={tab === value}
                    aria-controls="call-panel"
                    tabIndex={tab === value ? 0 : -1}
                    onClick={() => setTab(value)}
                    onKeyDown={(e) => {
                      if (
                        ["ArrowRight", "ArrowLeft", "Home", "End"].includes(
                          e.key,
                        )
                      ) {
                        e.preventDefault();
                        const last = tabs.length - 1;
                        const next =
                          e.key === "Home"
                            ? 0
                            : e.key === "End"
                              ? last
                              : (index + (e.key === "ArrowRight" ? 1 : last)) %
                                tabs.length;
                        setTab(tabs[next]);
                        document
                          .getElementById(`call-tab-${tabs[next]}`)
                          ?.focus();
                      }
                    }}
                  >
                    {t(`calls.tabs.${value}`)}
                  </button>
                ))}
              </div>
            </header>
            {(!replaying || session.active) && (
              <div className="status">
                {session.active && (
                  <>
                    <span>{t(`calls.micStates.${session.mic_state}`)}</span>
                    <span className="sep">·</span>
                  </>
                )}
                <span>{date(session)}</span>
                <span className="sep">·</span>
                <span>{app(session)}</span>
              </div>
            )}
          </div>
          {terra && callAssistieOpen && assistieCall === session.id && (
            <div className="call-assistie-popover">{assistiePanel}</div>
          )}
          <div
            id="call-panel"
            role="tabpanel"
            aria-labelledby={`call-tab-${tab}`}
            className="call-panel obs"
          >
            {tab === "transcript" && (
              <div
                className="panel call-transcript"
                ref={transcriptBox}
                onScroll={(e) => {
                  const box = e.currentTarget;
                  followingTranscript.current =
                    box.scrollHeight - box.scrollTop - box.clientHeight < 120;
                }}
              >
                {analysis?.transcript?.warnings.map((warning) => (
                  <p className="call-notice" key={warning}>
                    {warning}
                  </p>
                ))}
                {entries.length ? (
                  <>
                    {!!savedEntries?.length &&
                      !analysis?.transcript?.complete && (
                        <p className="call-muted">{t("calls.partial")}</p>
                      )}
                    {entries.map((entry) => (
                      <article
                        id={`passage-${entry.id}`}
                        tabIndex={-1}
                        className={`call-passage ${entry.source === "system" ? "call-remote" : ""} ${focus === entry.id ? "call-highlight" : ""}`}
                        key={entry.id}
                      >
                        <div className="call-speaker">
                          {t(
                            entry.source === "mic"
                              ? "calls.you"
                              : "calls.observatory.them",
                          )}
                          <span>{clock(entry.start_ms)}</span>
                        </div>
                        <p>{entry.text}</p>
                      </article>
                    ))}
                    {session.mic_gaps.map((gap) => (
                      <p className="call-muted" key={gap.start_ms}>
                        {t("calls.micGap", {
                          start: clock(gap.start_ms),
                          end: clock(gap.resumed_ms ?? session.elapsed_ms),
                        })}
                      </p>
                    ))}
                  </>
                ) : (
                  <p className="call-empty">
                    {t(
                      session.active
                        ? "calls.observatory.listening"
                        : working
                          ? "calls.transcriptWorking"
                          : analysis?.transcript?.complete
                            ? "calls.noSpeech"
                            : "calls.transcriptEmpty",
                    )}
                  </p>
                )}
              </div>
            )}
            {replaying &&
              (replay &&
              replay.call.started_ms > 0 &&
              (liveCall || Object.keys(replay.lines).length) ? (
                <CallObservatory
                  key={session.id}
                  data={replay}
                  live={liveCall}
                  view={tab as "system" | "terra"}
                  onOpenTerra={() => {
                    if (terra) setTab("terra");
                  }}
                />
              ) : (
                <p className="call-empty">
                  {t(
                    session.active
                      ? "calls.observatory.listening"
                      : replayFailed
                        ? "calls.observatory.loadFailed"
                        : replay
                          ? "calls.observatory.noLogs"
                          : "calls.observatory.loading",
                  )}
                </p>
              ))}
            {tab === "notes" && (
              <div className="split">
                <div className="panel call-summary">
                  <div className="call-summary-head">
                    <h2>{t("calls.summary")}</h2>
                    {analysis?.summary && (
                      <span className="pill" title={t("calls.aiDraft")}>
                        {t("calls.aiLabel")}
                      </span>
                    )}
                    <div className="call-summary-actions">
                      {working && (
                        <span className="calm" aria-live="polite">
                          {t(`calls.status.${analysis?.status ?? "idle"}`)}
                          {(analysis?.total ?? 0) > 1
                            ? ` · ${analysis?.done}/${analysis?.total}`
                            : ""}
                        </span>
                      )}
                      {!!analysis?.summary && !editing && !working && (
                        <button
                          className="text-btn"
                          onClick={() => {
                            const summary = analysis.summary!;
                            setDraft(
                              summary.edited_text ??
                                sections
                                  .filter((key) => summary.sections[key].length)
                                  .map(
                                    (key) =>
                                      `${t(`calls.sections.${key}`)}\n${summary.sections[key].map((p) => `• ${p.text}`).join("\n")}`,
                                  )
                                  .join("\n\n"),
                            );
                            setEditJob(summary.job_id);
                            setEditing(true);
                          }}
                        >
                          {t("calls.edit")}
                        </button>
                      )}
                      {!session.active && (
                        <button
                          className="text-btn"
                          disabled={busy || editing}
                          onClick={() =>
                            void action(
                              working
                                ? "cancel_call_processing"
                                : "process_call",
                              { sessionId: session.id },
                            )
                          }
                        >
                          {t(
                            working
                              ? "calls.cancelJob"
                              : analysis?.summary
                                ? "calls.update"
                                : "calls.generate",
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                  {analysis?.outdated && (
                    <p className="call-notice">{t("calls.outdated")}</p>
                  )}
                  {analysis?.summary ? (
                    editing ? (
                      <>
                        <textarea
                          className="call-notes call-summary-editor"
                          value={draft}
                          aria-label={t("calls.editSummary")}
                          onChange={(e) => setDraft(e.target.value)}
                        />
                        <div className="call-summary-actions">
                          <button
                            className="text-btn"
                            disabled={busy || working}
                            onClick={() => {
                              void action("save_call_summary", {
                                sessionId: session.id,
                                expectedJob: editJob,
                                text: draft,
                              }).then((success) => {
                                if (success) setEditing(false);
                              });
                            }}
                          >
                            {t("calls.save")}
                          </button>
                          <button
                            className="text-btn"
                            onClick={() => setEditing(false)}
                          >
                            {t("calls.cancelEdit")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        {analysis.summary.edited_text !== null ? (
                          <p className="call-edited">
                            {analysis.summary.edited_text}
                          </p>
                        ) : sections.some(
                            (key) => analysis.summary!.sections[key].length,
                          ) ? (
                          sections.map(
                            (key) =>
                              analysis.summary!.sections[key].length > 0 && (
                                <section
                                  className="call-summary-section"
                                  key={key}
                                >
                                  <h2>{t(`calls.sections.${key}`)}</h2>
                                  <ul>
                                    {analysis.summary!.sections[key].map(
                                      (point, index) => (
                                        <li key={index}>
                                          {point.text}
                                          <span className="call-citations">
                                            {analysis.summary!
                                              .transcript_version ===
                                              analysis.transcript?.version &&
                                              point.sources.map((id) => (
                                                <button
                                                  key={id}
                                                  onClick={() => cite(id)}
                                                  aria-label={t(
                                                    "calls.source",
                                                    {
                                                      time: clock(
                                                        analysis.transcript?.entries.find(
                                                          (e) => e.id === id,
                                                        )?.start_ms ?? 0,
                                                      ),
                                                    },
                                                  )}
                                                >
                                                  {clock(
                                                    analysis.transcript?.entries.find(
                                                      (e) => e.id === id,
                                                    )?.start_ms ?? 0,
                                                  )}
                                                </button>
                                              ))}
                                          </span>
                                        </li>
                                      ),
                                    )}
                                  </ul>
                                </section>
                              ),
                          )
                        ) : (
                          <p className="call-empty">
                            {t("calls.noSummaryPoints")}
                          </p>
                        )}
                      </>
                    )
                  ) : (
                    <p className="call-empty">
                      {t(
                        session.active
                          ? "calls.afterStop"
                          : working
                            ? "calls.summaryWorking"
                            : "calls.summaryEmpty",
                      )}
                    </p>
                  )}
                </div>
                <div className="side">
                  <div className="panel">
                    <h3>{t("calls.observatory.yourNotes")}</h3>
                    <textarea
                      className="call-notes"
                      aria-label={t("calls.notes")}
                      placeholder={t("calls.placeholder")}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      onBlur={() =>
                        void saveNotes().catch((e) => setError(String(e)))
                      }
                    />
                  </div>
                  {terra && !!replay?.replies.length && (
                    <div className="panel desk call-pointers">
                      <h3>
                        <Sparkles />
                        {t("calls.observatory.pointedOut")}
                        {!session.active && (
                          <button
                            className="text-btn end"
                            disabled={busy}
                            onClick={() => toggleAssistie(session)}
                          >
                            {t(
                              callAssistieOpen && assistieCall === session.id
                                ? "calls.assistie.close"
                                : "calls.observatory.allAnswers",
                            )}
                          </button>
                        )}
                      </h3>
                      {replay.replies.map((reply) => (
                        <div
                          className="said"
                          key={`${reply.terra_run}/${reply.event_id}`}
                        >
                          <Sparkles />
                          <div>
                            <div className="tx">{reply.text}</div>
                            <div className="tm">
                              {replayClock(
                                reply.received_at_ms - replay.call.started_ms,
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {detection?.possible_end && session.active && (
            <p className="call-muted">{t("calls.possibleEnd")}</p>
          )}
        </>
      )}
      {errors.length > 0 && (
        <p role="alert" className="call-error">
          {[...new Set(errors)].join(" ")}
        </p>
      )}
    </section>
  );
}
