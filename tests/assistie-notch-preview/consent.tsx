import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en/translation.json";
import { CallNotes } from "../../src/components/calls/CallNotes";
import type { AssistieSnapshot } from "../../src/components/calls/AssistiePanel";

await i18n
  .use(initReactI18next)
  .init({ lng: "en", resources: { en: { translation: en } } });
const call = {
  id: "fictional-call-21",
  title: "Fictional project check-in",
  started_at: "2026-10-18T12:00:00Z",
  active: true,
  mic_state: "live",
  mic_gaps: [],
  detected_app: "discord",
  elapsed_ms: 8000,
  notes: "Fictional notes stay local.",
  system: { samples: 0, sample_rate: 48000, error: null },
  mic_segments: [],
  error: null,
};
let visible = false;
const snapshot: AssistieSnapshot = {
  run_id: "meeting-" + "2".repeat(32),
  call_id: call.id,
  sharing: false,
  proactive: false,
  status: "off",
  version: 1,
  deadline_ms: null,
  startup_deadline_ms: null,
  context_brief: null,
  questions: [],
  replies: [],
};
mockIPC(
  (command, args) => {
    if (command === "list_saved_calls") return [structuredClone(call)];
    if (command === "call_notes_snapshot") return structuredClone(call);
    if (command === "call_detection_snapshot")
      return {
        available: true,
        apps: ["discord"],
        possible_end: false,
        dictating: false,
      };
    if (
      command === "create_call_assistie" ||
      command === "assistie_fixture_snapshot"
    )
      return structuredClone(snapshot);
    if (command === "assistie_notch_visible") return visible;
    if (command === "set_assistie_notch_visible") {
      visible = !!args?.visible;
      return visible;
    }
    if (command === "control_assistie_fixture") {
      snapshot.sharing = !!args?.sharing;
      snapshot.proactive = !!args?.proactive;
      snapshot.status = snapshot.sharing ? "following" : "disabled";
      return structuredClone(snapshot);
    }
    if (command === "stop_assistie_fixture") {
      snapshot.sharing = false;
      snapshot.proactive = false;
      snapshot.status = "disabled";
      visible = false;
      void emit("assistie-notch-visible", false);
      return structuredClone(snapshot);
    }
    if (command === "ask_assistie_fixture") {
      snapshot.questions.push({
        id: 1,
        text: String(args?.question),
        status: "answered",
        version: 1,
      });
      snapshot.replies.push({
        event_id: "q1-v1",
        snapshot_at_ms: Date.now() - 15000,
        question_id: 1,
        kind: "answer",
        version: 1,
        text: "Fictional UI answer: Monday, after the review passes.",
        quotes: [
          {
            id: "t-s1",
            text: "Fictional Monday agreement, conditional on review.",
          },
        ],
      });
      snapshot.version = 2;
      return structuredClone(snapshot);
    }
    if (command === "save_call_notes") {
      call.notes = String(args?.notes);
      return null;
    }
    throw new Error(`Unexpected fixture command ${command}`);
  },
  { shouldMockEvents: true },
);
createRoot(document.querySelector("#root")!).render(
  <React.StrictMode>
    <CallNotes />
  </React.StrictMode>,
);
