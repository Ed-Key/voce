import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en/translation.json";
import { AssistieNotch } from "../../src/notch/notch";
import type { AssistieSnapshot } from "../../src/components/calls/AssistiePanel";
import type { FeedItem } from "../../src/notch/feed";
import "../../src/styles/theme.css";
import "../../src/notch/notch.css";

await i18n
  .use(initReactI18next)
  .init({ lng: "en", resources: { en: { translation: en } } });

// ?state= one of the board frames (quiet, thinking, pointer, closed, open, ended); fictional text only.
// ?terra: the Terra route, so the rating row shows; ?markfail: marks fail to save;
// ?markrefuse: the command itself refuses the mark.
const params = new URLSearchParams(location.search);
const preset = params.get("state");
const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).getTime();
const callMs = (m: number, s: number) => (m * 60 + s) * 1000;
const snapshot: AssistieSnapshot = {
  run_id: "fictional-browser-chat-1",
  sharing: true,
  proactive: true,
  status: "following",
  transport: params.has("terra") || preset ? "codex" : null,
  marks: [],
  version: 1,
  deadline_ms: null,
  startup_deadline_ms: null,
  context_brief: null,
  questions: [],
  replies: [],
  reply_count: 0,
  you_speaking: false,
};
const items: FeedItem[] = [];
const seenLog = new Set<number>();
let failedOnce = false;
let failNext = false;
let notchVisible = true;
const log: string[] = [];
function record(value: string) {
  log.push(`${Math.round(performance.now())} ${value}`);
  document.querySelector("#events")!.textContent = log.slice(-18).join("\n");
}
function publish(
  kind: "answer" | "pointer",
  text: string,
  options: {
    question?: string;
    time?: number;
    quotes?: FeedItem["reply"]["quotes"];
  } = {},
) {
  const n = items.length + 1;
  const question = options.question
    ? { id: n, text: options.question, version: 1, status: "answered" }
    : null;
  if (question) snapshot.questions.push(question);
  const reply = {
    event_id: `${kind[0]}${n}`,
    question_id: question?.id ?? null,
    kind,
    version: 1,
    received_at_ms: options.time ?? Date.now(),
    text,
    quotes: options.quotes ?? [],
  };
  items.push({ n, reply, question });
  snapshot.replies = [...snapshot.replies, reply].slice(-3);
  snapshot.reply_count = n;
  void emit("assistie-fixture-changed", structuredClone(snapshot));
  record(`${kind} ${n}`);
}
const answer = () =>
  publish(
    "answer",
    "Priya approves anything over $10,000. She said it before the vendor discussion.",
    {
      question: "Who approves the budget?",
      time: at(12, 39),
      quotes: [
        {
          id: "t-a1",
          text: "Anything over ten thousand comes to me first.",
          source: "other_audio",
          start_ms: callMs(38, 12),
        },
      ],
    },
  );
const maya = () =>
  publish("pointer", "Maya asked about the launch date twice.", {
    time: at(12, 40),
  });
const kenji = () =>
  publish("pointer", "Kenji owns the review, per your notes from Oct 28.", {
    time: at(12, 40),
  });
const vendor = () =>
  publish("pointer", "The vendor quote is still $12,400.", {
    time: at(12, 36),
  });

mockIPC(
  (command, args) => {
    if (command === "assistie_notch_visible") return notchVisible;
    if (command === "assistie_fixture_snapshot")
      return structuredClone(snapshot);
    if (command === "notch_seen_replies") return [...seenLog];
    if (command === "record_notch_events") {
      for (const event of args?.events as { n: number; action: string }[]) {
        if (event.action === "seen" || event.action === "dismissed")
          seenLog.add(event.n);
        record(`log ${event.action} ${event.n}`);
      }
      return null;
    }
    if (command === "assistie_notch_feed") {
      // ?feedfail: the first read fails, as after a bridge hiccup.
      if (failNext && (args as { after: number | null }).after !== null) {
        failNext = false;
        throw new Error("Meeting bridge busy");
      }
      if (params.has("feedfail") && !failedOnce) {
        failedOnce = true;
        throw new Error("Meeting bridge busy");
      }
      const { before, after, limit } = args as {
        before: number | null;
        after: number | null;
        limit: number;
      };
      const readable = snapshot.sharing ? items : [];
      let page: FeedItem[];
      if (after !== null)
        page = readable.filter((i) => i.n > after).slice(0, limit);
      else
        page = readable
          .filter((i) => before === null || i.n < before)
          .slice(-limit);
      const result = {
        run_id: snapshot.run_id,
        reply_count: items.length,
        items: structuredClone(page),
        more_before: !!page[0] && page[0].n > 1,
      };
      // ?slowpages: reads take time and return short pages, as the bridge's byte cap can.
      if (params.has("slowpages") && after !== null) {
        result.items = result.items.slice(0, 5);
        return new Promise((resolve) =>
          setTimeout(() => {
            record(`feed read after ${after}`);
            resolve(result);
          }, 300),
        );
      }
      return result;
    }
    if (command === "layout_assistie_notch") {
      const mode = args?.mode as string;
      const stage = document.querySelector<HTMLElement>("#stage")!;
      stage.style.transition = args?.reduceMotion
        ? "none"
        : "width 220ms cubic-bezier(0.16,1,0.3,1), height 300ms cubic-bezier(0.16,1,0.3,1)";
      stage.style.width = mode === "compact" ? "288px" : "448px";
      stage.style.height =
        mode === "expanded"
          ? "420px"
          : mode === "peek"
            ? `${80 + (Math.min(Number(args?.lines ?? 1), 16) - 1) * 18}px`
            : "42px";
      void emit("assistie-notch-geometry", {
        width: mode === "compact" ? 288 : 448,
        camera_width: 184,
        header_height: 38,
      });
      record(`layout ${mode}`);
      return true;
    }
    if (command === "edit_assistie_notch") {
      record(`mock keyboard ${args?.editing}`);
      return false;
    }
    if (command === "ask_assistie_fixture") {
      const id = 100 + snapshot.questions.length;
      snapshot.questions.push({
        id,
        text: args?.question as string,
        status: "pending",
        version: 1,
      });
      setTimeout(() => {
        snapshot.questions = snapshot.questions.filter((q) => q.id !== id);
        publish(
          "answer",
          "Monday is agreed. Lee finished the review and it passed.",
          {
            question: args?.question as string,
          },
        );
      }, 1200);
      return structuredClone(snapshot);
    }
    if (command === "rate_terra_reply") {
      if (params.has("markrefuse")) throw new Error("Terra is not running");
      const mark = {
        id: `m${snapshot.marks!.length + 1}`,
        event_id: args?.eventId as string | null,
        rating: args?.rating as "good" | "bad" | "missed",
        note: args?.note as string,
        at_ms: Date.now(),
        status: "pending" as "pending" | "saved" | "failed",
      };
      snapshot.marks!.push(mark);
      setTimeout(() => {
        mark.status = params.has("markfail") ? "failed" : "saved";
        void emit("assistie-fixture-changed", structuredClone(snapshot));
      }, 300);
      record(`mark ${mark.rating} ${mark.event_id}`);
      return structuredClone(snapshot);
    }
    if (command === "control_assistie_fixture") {
      snapshot.proactive = args?.proactive as boolean;
      return structuredClone(snapshot);
    }
    if (command === "stop_assistie_fixture") {
      snapshot.sharing = false;
      snapshot.status = "disabled";
      // Like hide_after_saved in notch.rs: "Saved" first, then the notch hides.
      setTimeout(hideStage, 4000);
      record("sharing off");
      return structuredClone(snapshot);
    }
    if (command === "set_assistie_notch_visible") {
      hideStage();
      return false;
    }
    throw new Error(`Unexpected fixture command ${command}`);
  },
  { shouldMockEvents: true },
);
function hideStage() {
  notchVisible = false;
  void emit("assistie-notch-visible", false);
  document.querySelector<HTMLElement>("#stage")!.style.display = "none";
  record("notch hidden");
}

document.querySelector("#reply")!.addEventListener("click", answer);
document.querySelector("#pointer")!.addEventListener("click", kenji);
document.querySelector("#pause")!.addEventListener("click", () => {
  snapshot.sharing = !snapshot.sharing;
  void emit("assistie-fixture-changed", structuredClone(snapshot));
  record(`sharing ${snapshot.sharing}`);
});
// Live call loudness as Handy's hover loop would emit it: [your mic, call audio].
(window as unknown as { notchLevels: (levels: number[]) => void }).notchLevels =
  (levels) => void emit("assistie-notch-levels", levels);
document.querySelector("#show")!.addEventListener("click", () => {
  notchVisible = true;
  document.querySelector<HTMLElement>("#stage")!.style.display = "block";
  void emit("assistie-notch-visible", true);
  record("notch shown");
});
// A transcript correction, as the snapshot shows it: the older reply is past the newest three and
// the invalidated pointer is filtered out, so only the feed can report either one.
document.querySelector("#correct")!.addEventListener("click", () => {
  const older = items[0];
  const invalidated = items[items.length - 1];
  older.reply.source_status = "revised";
  invalidated.reply.source_status = "revised";
  snapshot.replies = snapshot.replies.filter(
    (r) => r.event_id !== invalidated.reply.event_id,
  );
  snapshot.version += 1;
  void emit("assistie-fixture-changed", structuredClone(snapshot));
  record("transcript corrected");
});
document.querySelector("#tall")!.addEventListener("click", () => {
  publish("pointer", "A fictional reply that keeps going. ".repeat(170));
});
// Sources that left the live window: the pointer has no saved quote, the answer keeps one.
document.querySelector("#aged")!.addEventListener("click", () => {
  items[0].reply.source_status = "outside_window";
  items[1].reply.source_status = "outside_window";
  snapshot.version += 1;
  void emit("assistie-fixture-changed", structuredClone(snapshot));
});
document.querySelector("#hide")!.addEventListener("click", hideStage);
document.querySelector("#fail-next")!.addEventListener("click", () => {
  failNext = true;
});
document.querySelector("#work")!.addEventListener("click", () => {
  snapshot.terra_working = !snapshot.terra_working;
  snapshot.terra_working_since_ms = snapshot.terra_working ? Date.now() : null;
  void emit("assistie-fixture-changed", structuredClone(snapshot));
  record(`terra working ${snapshot.terra_working}`);
});
document.querySelector("#talk")!.addEventListener("click", () => {
  snapshot.you_speaking = !snapshot.you_speaking;
  record(`you speaking ${snapshot.you_speaking}`);
});
for (const inside of [true, false]) {
  document
    .querySelector(inside ? "#native-enter" : "#native-leave")!
    .addEventListener("click", () => {
      void emit("assistie-notch-hover", inside);
      record(`native pointer ${inside ? "enter" : "leave"}`);
    });
}
document.querySelector("#stop")!.addEventListener("click", () => {
  snapshot.sharing = false;
  snapshot.status = "disabled";
  void emit("assistie-fixture-changed", structuredClone(snapshot));
  setTimeout(hideStage, 4000);
});

// Board frames. Replies that exist before the notch loads are history; later ones arrive live.
const later = (run: () => void, ms: number) => setTimeout(run, ms);
if (preset === "thinking")
  snapshot.questions.push({
    id: 1,
    text: "Who approves the budget?",
    version: 1,
    status: "pending",
  });
if (preset === "pointer") {
  later(maya, 600);
  later(kenji, 1200);
}
if (preset === "many") {
  for (let i = 1; i <= 14; i++)
    publish("pointer", `Fictional pointer number ${i}.`, { time: at(12, 40) });
}
if (preset === "closed") {
  maya();
  kenji();
}
if (preset === "open") {
  vendor();
  seenLog.add(1);
  answer();
  seenLog.add(2);
  maya();
  kenji();
  later(() => void emit("assistie-notch-hover", true), 400);
}
if (preset === "ended") {
  snapshot.sharing = false;
  snapshot.status = "disabled";
}

createRoot(document.querySelector("#root")!).render(
  <React.StrictMode>
    <AssistieNotch />
  </React.StrictMode>,
);

document.addEventListener(
  "mouseenter",
  (event) => {
    if ((event.target as HTMLElement).classList?.contains("assistie-notch"))
      record("pointer enter");
  },
  true,
);
document.addEventListener(
  "mouseleave",
  (event) => {
    if ((event.target as HTMLElement).classList?.contains("assistie-notch"))
      record("pointer leave");
  },
  true,
);
