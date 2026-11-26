import type {
  ObservatoryData,
  Turn,
} from "@/components/calls/observatoryPlayer";

// The simulation's made-up call, in the shape the exporter returns. Times are milliseconds from the start.
const START = 1_793_300_000_000;
const SCRIPT: [number, "them" | "you", string][] = [
  [1000, "them", "Morning. Quick sync on the launch?"],
  [4200, "you", "Sure. Where are we on the release notes?"],
  [8000, "them", "Drafted. We moved the launch to Friday."],
  [12400, "you", "Who is doing the final review?"],
  [15400, "them", "Kenji said he would take it."],
  [19000, "them", "Can we still ship on Friday?"],
  [22600, "you", "Only if the review is done by Thursday."],
  [27000, "them", "<img src=x onerror=window.__pwned=1>"],
  [31000, "you", "And the budget sign-off. My limit covers it."],
];
const TOKENS = {
  inputTokens: 1400,
  cachedInputTokens: 1200,
  outputTokens: 12,
  reasoningOutputTokens: 0,
  totalTokens: 1412,
};

export function fixture(): ObservatoryData {
  const lines: ObservatoryData["lines"] = {};
  const turns: Turn[] = [];
  SCRIPT.forEach(([ms, who, text], index) => {
    const words = text.split(" ");
    const audio = [ms, ms + 2000];
    lines[`asr-${index}`] = {
      source: who === "you" ? "you" : "other_audio",
      // Line 3 is dropped by a restart and finished under the same id: it must still show.
      dropped:
        index === 3 ? { epoch_ms: START + ms + 1000, reason: "restart" } : null,
      revisions: [
        {
          epoch_ms: START + ms + 900,
          stage: "guess",
          text: words.slice(0, 2).join(" "),
          audio_ms: audio,
        },
        { epoch_ms: START + ms + 2300, stage: "final", text, audio_ms: audio },
      ],
    };
    const shown = index === 4;
    const settle = START + ms + 4200;
    turns.push({
      terra_run: "meeting-t",
      event_id: `p${index}`,
      kind: "pointer",
      question: null,
      event_ms: START + ms + 2400,
      request_ms: START + ms + 2400,
      lines_sent: [{ id: `t-asr-${index}`, text }],
      output_ms: settle - 10,
      first_text_ms: settle - 500,
      raw: shown ? '{"pointer":"Kenji owns the review"}' : "NO_POINTER",
      settle_ms: settle,
      reason: shown ? "published" : index === 2 ? "overtaken" : "silent",
      why: null,
      payload: shown
        ? {
            text: "Kenji owns the review, per your notes from Oct 28.",
            sources: ["t-asr-4"],
          }
        : null,
      tokens: TOKENS,
      message: `{"lines":[${JSON.stringify(text)}]}`,
      sent_kind: "request",
      complete: true,
    });
  });
  return {
    call: { started_ms: START, ended_ms: START + 36000 },
    lines,
    engine: [
      { epoch_ms: START + 100, event: "run start", reason: null },
      { epoch_ms: START + 300, event: "ready", reason: null },
    ],
    turns,
    sessions: [
      { model: "gpt-6.1-terra", effort: "low", brief: "Facts about you." },
    ],
    replies: [
      {
        event_id: "p4",
        terra_run: "meeting-t",
        text: "Kenji owns the review, per your notes from Oct 28.",
        sources: ["t-asr-4"],
        received_at_ms: START + 19600,
      },
    ],
    problems: [],
  };
}
