import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en/translation.json";
import {
  AssistiePanel,
  type AssistieSnapshot,
} from "../../src/components/calls/AssistiePanel";

await i18n
  .use(initReactI18next)
  .init({ lng: "en", resources: { en: { translation: en } } });
let visible = false;
const start = Date.now() - 60000;
const snapshot: AssistieSnapshot = {
  run_id: "fictional-history-23",
  call_id: "fictional-call-history",
  sharing: true,
  proactive: false,
  status: "following",
  version: 3,
  deadline_ms: null,
  startup_deadline_ms: null,
  context_brief: null,
  questions: [
    {
      id: 1,
      text: "What was the first launch plan?",
      status: "answered",
      version: 1,
    },
    {
      id: 2,
      text: "What is the updated plan?",
      status: "answered",
      version: 3,
    },
  ],
  replies: [
    {
      event_id: "q1-v1",
      question_id: 1,
      kind: "answer",
      version: 1,
      snapshot_at_ms: start,
      source_status: "revised",
      text: "Friday, only if the accessibility review passes. The review has no owner yet.",
      quotes: [
        {
          id: "t-s1",
          text: "Friday is conditional on accessibility. The review is still unassigned.",
        },
      ],
    },
    {
      event_id: "q2-v3",
      question_id: 2,
      kind: "answer",
      version: 3,
      snapshot_at_ms: start + 30000,
      text: "The team now agrees Monday. Lee completed the accessibility review and it passed.",
      quotes: [
        {
          id: "t-s2",
          text: "We agree Monday. Lee completed the review and it passed.",
        },
      ],
    },
  ],
};
// ?terra: the Terra route, so each live reply shows the rating row.
if (new URLSearchParams(location.search).has("terra")) {
  snapshot.transport = "codex";
  snapshot.marks = [];
}
const copy = () => structuredClone(snapshot);
mockIPC(
  (command, args) => {
    if (command === "assistie_notch_visible") return visible;
    if (command === "set_assistie_notch_visible") {
      visible = !!args?.visible;
      return visible;
    }
    throw new Error(`Unexpected preview command ${command}`);
  },
  { shouldMockEvents: true },
);
document.querySelector("#advance")!.addEventListener("click", () => {
  snapshot.version++;
  snapshot.replies[1].source_status = "outside_window";
});
document.querySelector("#revise")!.addEventListener("click", () => {
  snapshot.version++;
  snapshot.replies[1].source_status = "revised";
});
createRoot(document.querySelector("#root")!).render(
  <React.StrictMode>
    <AssistiePanel
      callId={snapshot.call_id!}
      load={async () => copy()}
      stop={async () => {
        snapshot.sharing = false;
        snapshot.proactive = false;
        snapshot.status = "disabled";
        return copy();
      }}
      control={async (sharing, proactive) => {
        snapshot.sharing = sharing;
        snapshot.proactive = proactive;
        return copy();
      }}
      rate={async (rating, eventId) => {
        snapshot.marks!.push({
          id: `m${snapshot.marks!.length + 1}`,
          event_id: eventId,
          rating,
          note: "",
          at_ms: Date.now(),
          status: "saved",
        });
        return copy();
      }}
      ask={async (question) => {
        const id = snapshot.questions.length + 1;
        snapshot.questions.push({
          id,
          text: question,
          version: snapshot.version,
          status: "pending",
        });
        setTimeout(() => {
          snapshot.questions[snapshot.questions.length - 1].status = "answered";
          snapshot.replies.push({
            event_id: `q${id}`,
            question_id: id,
            kind: "answer",
            version: snapshot.version,
            snapshot_at_ms: Date.now(),
            text: "Fictional follow-up: confirm the latest plan with the team. Earlier answers describe their own snapshots.",
            quotes: [
              {
                id: "t-s3",
                text: "The latest draft still needs confirmation.",
              },
            ],
          });
        }, 1800);
        return copy();
      }}
    />
  </React.StrictMode>,
);
