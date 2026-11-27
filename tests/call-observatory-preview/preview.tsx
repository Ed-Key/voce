import React from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import "@/App.css";
import "@/i18n";
import { CallNotes } from "@/components/calls/CallNotes";
import { MemoryPage } from "@/components/calls/MemoryPage";
import { useSettingsStore } from "@/stores/settingsStore";
import { fixture } from "./fixture";

const session = (id: string, title: string, active = false) => ({
  id,
  title,
  started_at: "2026-10-30T10:00:00+00:00",
  active,
  mic_state: active ? "live" : "stopped",
  mic_gaps: [],
  detected_app: "zoom",
  elapsed_ms: 73000,
  notes: "",
  system: { samples: 0, sample_rate: 48000, error: null },
  mic_segments: [],
  error: null,
});
const analysis = {
  audio: { managed: true, expires_at: null, expired: false },
  status: "ready",
  error: null,
  done: 1,
  total: 1,
  transcript: {
    complete: true,
    version: "v",
    entries: [
      {
        id: 1,
        source: "mic",
        start_ms: 4200,
        end_ms: 6000,
        text: "Where are we on the release notes?",
      },
    ],
    warnings: [],
  },
  summary: {
    job_id: "j",
    transcript_version: "v",
    sections: {
      overview: [{ text: "The launch stays on Friday.", sources: [1] }],
      decisions: [{ text: "Copy changes only this week.", sources: [1] }],
      action_items: [],
      open_questions: [],
    },
    edited_text: null,
  },
  outdated: false,
};
let lateReads = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let terraRun: any = null;
let terraRuns = 0;
// A small stand-in for memory.py: the lifecycle itself is tested in test_memory.py.
const fromDots = (text: string, date: string) => [
  { origin: "dots", excerpt: text, source_date: date },
];
const memoryState = {
  waiting: [
    {
      id: 2,
      group: "person",
      subject: "person:Dana",
      text: "Dana is in the office on Wednesdays",
      state: "waiting",
      sources: fromDots("", "2026-10-20"),
      flags: [] as string[],
      conflicts: [
        {
          id: 1,
          group: "person",
          subject: "person:Dana",
          text: "Dana is in the office on Tuesdays",
          state: "current",
          sources: fromDots("", "2026-09-01"),
          flags: [] as string[],
          conflicts: [],
        },
      ],
    },
    {
      id: 3,
      group: "person",
      subject: "person:Noor",
      text: "Send invoices to billing@example.test",
      state: "waiting",
      sources: [{ origin: "claude", excerpt: "", source_date: null }],
      flags: ["contact"],
      conflicts: [],
    },
  ],
  current: [
    {
      id: 1,
      group: "person",
      subject: "person:Dana",
      text: "Dana is in the office on Tuesdays",
      state: "current",
      sources: fromDots("", "2026-09-01"),
      flags: [] as string[],
      conflicts: [],
    },
    {
      id: 4,
      group: "story",
      subject: "you",
      text: "Led the fictional Orchard migration: found the slow query, moved the team to batches, cut load time by half.",
      state: "current",
      sources: [{ origin: "ed", excerpt: "", source_date: "2026-10-31" }],
      flags: [] as string[],
      conflicts: [],
    },
  ],
  brief:
    "Stories:\n- Led the fictional Orchard migration: found the slow query, moved the team to batches, cut load time by half.\n\nPeople:\n- Dana is in the office on Tuesdays (as of Tue 2026-09-01)",
  size: 240,
  budget: 8192,
  left_out: [] as number[],
};
function memoryReply(
  action: string,
  value: { id?: number; text?: string; group?: string },
) {
  const m = memoryState;
  if (
    (window as unknown as { __memoryFail?: boolean }).__memoryFail &&
    action !== "list"
  )
    throw "disk is full";
  const waiting = m.waiting.find((e) => e.id === value.id);
  if (action === "approve" || (action === "edit" && waiting)) {
    if (waiting) {
      m.current = m.current.filter(
        (e) => !waiting.conflicts.some((c) => c.id === e.id),
      );
      m.current.unshift({
        ...waiting,
        text: value.text ?? waiting.text,
        state: "current",
        conflicts: [],
        flags: [],
      });
    }
  }
  if (action === "edit" && !waiting)
    m.current = m.current.map((e) =>
      e.id === value.id ? { ...e, text: value.text! } : e,
    );
  if (action === "reject" || action === "delete")
    m.current = m.current.filter((e) => e.id !== value.id);
  if (action === "approve" || action === "reject" || action === "edit")
    m.waiting = m.waiting.filter((e) => e.id !== value.id);
  if (action === "add")
    m.current.unshift({
      id: Date.now(),
      group: value.group!,
      subject: "you",
      text: value.text!,
      state: "current",
      sources: [],
      flags: [],
      conflicts: [],
    });
  const over = (window as unknown as { __memoryOver?: boolean }).__memoryOver;
  return JSON.stringify({ ...m, left_out: over ? [4] : [] });
}
let liveReads = 0;
let stopped = false;
const deleted: string[] = [];
const realCall = new URLSearchParams(location.search).get("real");
// Terra is experimental: on here unless ?terraoff. `__setExperimental` flips the switch the way Settings does.
let experimental = !new URLSearchParams(location.search).has("terraoff");
Object.assign(window, {
  __setExperimental: (on: boolean) => {
    experimental = on;
    return useSettingsStore.getState().refreshSettings();
  },
});

mockIPC(
  async (command, args) => {
    const id = (args as { sessionId?: string })?.sessionId;
    if (command === "get_app_settings")
      return { experimental_enabled: experimental };
    if (command === "list_saved_calls") {
      const day = (ago: number, hour: number) => {
        const when = new Date();
        when.setDate(when.getDate() - ago);
        when.setHours(hour, 15);
        return when.toISOString();
      };
      return [
        {
          ...session("live", "Live call", !stopped),
          started_at: new Date(Date.now() - 60_000).toISOString(),
          elapsed_ms: 60_000,
        },
        { ...session("sample", "Launch sync"), started_at: day(0, 9) },
        { ...session("design", "Design review"), started_at: day(0, 8) },
        { ...session("demo", "Partner demo prep"), started_at: day(1, 15) },
        { ...session("budget", "Budget check"), started_at: day(1, 11) },
        { ...session("old", "Old call"), started_at: day(5, 10) },
        {
          ...session("late", "Short call"),
          started_at: new Date().toISOString(),
          elapsed_ms: 0,
        },
      ].filter((call) => !deleted.includes(call.id));
    }
    if (command === "call_analysis")
      return id === "live"
        ? { ...analysis, transcript: null, summary: null }
        : analysis;
    const terra = window as unknown as {
      __terraCalls: string[];
      __terraFail?: boolean;
      __terraSlowRead?: boolean;
      __terraReading?: boolean;
    };
    terra.__terraCalls ??= [];
    const terraCommands = [
      "create_call_assistie",
      "assistie_fixture_snapshot",
      "connect_terra_meeting",
      "control_assistie_fixture",
      "stop_assistie_fixture",
      "ask_assistie_fixture",
      "set_assistie_notch_visible",
    ];
    if (terraCommands.includes(command)) {
      if (command !== "assistie_fixture_snapshot")
        terra.__terraCalls.push(command);
      const a = args as {
        proactive?: boolean;
        question?: string;
        sessionId?: string;
      };
      if (command === "assistie_fixture_snapshot" && terra.__terraSlowRead) {
        const stale = terraRun && { ...terraRun };
        terra.__terraSlowRead = false;
        terra.__terraReading = true;
        await new Promise((done) => setTimeout(done, 600));
        if (!stale) throw new Error("Unknown meeting session");
        return stale;
      }
      if (command === "connect_terra_meeting" && terra.__terraFail)
        throw new Error("no");
      if (
        command === "create_call_assistie" &&
        (!terraRun || terraRun.status === "disabled")
      ) {
        terraRun = {
          run_id: `run-${++terraRuns}`,
          status: "off",
          sharing: false,
          proactive: false,
          call_id: a.sessionId,
          version: 1,
          questions: [],
          replies: [],
          context_brief: null,
          deadline_ms: null,
          startup_deadline_ms: null,
        };
      }
      if (command === "connect_terra_meeting")
        Object.assign(terraRun, {
          status: "following",
          sharing: true,
          proactive: a.proactive,
          connection: { phase: "connected" },
        });
      if (command === "control_assistie_fixture")
        terraRun.proactive = a.proactive;
      if (command === "stop_assistie_fixture")
        Object.assign(terraRun, {
          status: "disabled",
          sharing: false,
          proactive: false,
        });
      if (command === "ask_assistie_fixture") {
        const id = terraRun.questions.length + 1;
        const missing = a.question?.includes("missing");
        terraRun.questions = [
          ...terraRun.questions,
          {
            id,
            text: a.question,
            version: 1,
            status: missing ? "failed" : "answered",
          },
        ];
        if (!missing)
          terraRun.replies = [
            ...terraRun.replies,
            {
              event_id: `q${id}`,
              question_id: id,
              kind: "answer",
              version: 1,
              text: "Friday, if Kenji finishes the review.",
              source_status: a.question?.includes("revised") ? "revised" : null,
              quotes: [],
            },
          ];
      }
      return command === "set_assistie_notch_visible" ? true : { ...terraRun };
    }
    if (command === "memory_command") {
      const { command: action, payload } = args as {
        command: string;
        payload: string;
      };
      return memoryReply(action, JSON.parse(payload));
    }
    if (command === "delete_call") {
      deleted.push(id as string);
      return null;
    }
    if (command === "stop_call_notes") {
      stopped = true;
      return null;
    }
    if (command === "call_observatory" && id === "live") {
      const data = fixture();
      data.call.started_ms = Date.now() - 60_000;
      data.call.ended_ms = 0;
      data.problems = ["a row cut short"];
      const keep = Math.min(2 + ++liveReads, 9);
      data.turns = [];
      data.replies = [];
      data.lines = Object.fromEntries(
        Object.entries(data.lines)
          .slice(0, keep)
          .map(([key, line], index) => [
            key,
            {
              ...line,
              revisions: line.revisions.map((r) => ({
                ...r,
                epoch_ms: data.call.started_ms + 1000 * index,
              })),
            },
          ]),
      );
      return JSON.stringify(data);
    }
    if (command === "call_observatory") {
      if (realCall) return (await fetch(realCall)).text();
      if (id === "old")
        return JSON.stringify({
          ...fixture(),
          lines: {},
          turns: [],
          replies: [],
        });
      if (id === "late") {
        const data = fixture();
        if (++lateReads > 3) {
          return JSON.stringify(data);
        }
        delete data.lines["asr-8"];
        return JSON.stringify(data);
      }
      return JSON.stringify(fixture());
    }
    if (command === "call_detection_snapshot")
      return {
        available: true,
        apps: [],
        possible_end: false,
        dictating: false,
      };
    if (command === "plugin:event|listen") return 1;
    if (command === "assistie_plugin_status")
      return { running: false, phase: "offline" };
    return null;
  },
  { shouldMockEvents: true },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="h-screen overflow-y-auto p-4">
    {location.search.includes("memory") ? <MemoryPage /> : <CallNotes />}
  </div>,
);
