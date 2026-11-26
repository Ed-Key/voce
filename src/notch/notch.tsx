import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronUp,
  Clock3,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  Square,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThinkingOrb } from "thinking-orbs";
import type { AssistieSnapshot } from "../components/calls/AssistiePanel";
import { RatingRow } from "../components/calls/RatingRow";
import { canRate } from "../components/calls/rating";
import {
  applySourceStatus,
  initialFeed,
  landing,
  merge,
  PACING,
  readable,
  step,
  type FeedEvent,
  type FeedItem,
  type FeedPage,
  type Surface,
} from "./feed";
import { notchProfile } from "./profile";
import { notchPhase } from "./state";
import { HOVER_DWELL_MS, LEAVE_GRACE_MS, PeekClock } from "./timing";

const PAGE = 30;
// The level bars: Handy's dictation waveform, fed by the call's live loudness.
const WAVE_SHAPE = [0.5, 0.72, 0.9, 1, 0.9, 0.72, 0.5];

/** Heights in px for the wave: flat dots when quiet, a moving crest while someone talks. */
/**
 * Loudness on a meter scale (decibels). Calibrated on the user's MacBook mic: a quiet room sits around
 * -46 to -38 dB and reads as flat dots; speech (-30 dB and up) stands clear of it.
 */
export function loudness(rms: number) {
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 38) / 23));
}

export function waveHeights(level: number, now: number) {
  const v = loudness(level);
  return WAVE_SHAPE.map((shape, i) => {
    const wobble = 0.75 + 0.25 * Math.sin(now / 90 + i * 1.7);
    return Math.max(
      2,
      Math.min(14, 2 + Math.pow(v, 0.7) * 12 * shape * wobble),
    );
  });
}

type Quote = FeedItem["reply"]["quotes"][number];

/** Call time of a cited line, as the transcript shows it. */
function callTime(ms: number) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${mm}:${ss}`
    : `${Math.floor(s / 60)}:${ss}`;
}

/** The level bars. Its own component, so a reading ~13 times a second re-renders only the bars. */
function NotchWave() {
  // [your mic, call audio]; Handy sends a fresh reading each tick, 0 once a track goes quiet.
  const [levels, setLevels] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const unlisten = listen<[number, number]>(
      "assistie-notch-levels",
      (event) => setLevels(event.payload),
    );
    return () => void unlisten.then((stop) => stop());
  }, []);
  const level = Math.max(...levels);
  // Terra teal: dim dots while the call is quiet, bright while anyone is talking.
  const who = loudness(level) < 0.12 ? "" : " live";
  return (
    <span className={`notch-wave${who}`} aria-hidden="true">
      {waveHeights(level, Date.now()).map((h, i) => (
        <i key={i} style={{ height: `${h}px` }} />
      ))}
    </span>
  );
}

export function AssistieNotch() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [snapshot, setSnapshot] = useState<AssistieSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [composing, setComposing] = useState(false);
  const [question, setQuestion] = useState("");
  const [openSources, setOpenSources] = useState<Set<number>>(new Set());
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [geometry, setGeometry] = useState({
    width: 448,
    camera_width: 184,
    header_height: 38,
  });
  // The chat: every reply of this run, kept by reply number, and what the user has not seen yet.
  const [items, setItems] = useState<FeedItem[]>([]);
  const [moreBefore, setMoreBefore] = useState(false);
  const [feed, setFeed] = useState(initialFeed);
  const [feedReady, setFeedReady] = useState(false);
  const [feedAttempt, setFeedAttempt] = useState(0);
  const [newBelow, setNewBelow] = useState(0);

  const generation = useRef(0);
  const acting = useRef(false);
  const root = useRef<HTMLElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const askField = useRef<HTMLInputElement>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>();
  const dwellTimer = useRef<ReturnType<typeof setTimeout>>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const suppressHover = useRef(false);
  const nativeHover = useRef(false);
  const pointerInside = useRef(false);
  const interaction = useRef({ visible, expanded, pinned });
  interaction.current = { visible, expanded, pinned };
  const peekClock = useRef(new PeekClock());
  const feedRun = useRef("");
  const lastNumber = useRef(0);
  const fetching = useRef(false);
  const loadingOlder = useRef(false);
  const seenTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const revalidation = useRef({ version: -1, at: 0, busy: false });
  const atBottom = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const feedNow = useRef(feed);
  feedNow.current = feed;
  const surface: Surface = !visible ? "hidden" : expanded ? "open" : "closed";
  const surfaceNow = useRef(surface);
  surfaceNow.current = surface;
  const speaking = !!snapshot?.you_speaking;
  // Terra is working on a question or deciding on a pointer. Shown only once that work is at
  // least 600 ms old when a poll sees it, so a quick check never flashes the orb, even late.
  const since = snapshot?.terra_working
    ? snapshot.terra_working_since_ms
    : null;
  // Judged once per snapshot, so an unrelated re-render (a hover) cannot revive stale work.
  const thinking = useMemo(
    () => since != null && Date.now() - since >= 600,
    [snapshot],
  );
  const speakingNow = useRef(speaking);
  speakingNow.current = speaking;

  useEffect(() => {
    let disposed = false;
    const subscriptions = [
      listen<boolean>("assistie-notch-hover", (event) => {
        if (!disposed) updateHover(event.payload, true);
      }),
      listen<{ width: number; camera_width: number; header_height: number }>(
        "assistie-notch-geometry",
        (event) => {
          if (!disposed) setGeometry(event.payload);
        },
      ),
      listen<boolean>("assistie-notch-visible", (event) => {
        if (!disposed) {
          generation.current++;
          setVisible(event.payload);
        }
      }),
      listen<AssistieSnapshot>("assistie-fixture-changed", (event) => {
        if (!disposed) {
          generation.current++;
          setSnapshot(event.payload);
          setError(false);
        }
      }),
    ];
    void invoke<boolean>("assistie_notch_visible")
      .then((value) => {
        if (!disposed) setVisible(value);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
      subscriptions.forEach((p) => {
        void p.then((unlisten) => unlisten());
      });
    };
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReduceMotion(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    if (!visible) {
      setExpanded(false);
      setPinned(false);
      setOpenSources(new Set());
      setQuestion("");
      setHovered(false);
      setComposing(false);
      setFeed((value) => step(value, { type: "hidden" }));
      // Replies that land while hidden only count: no new-reply fetch until the show reloads.
      setFeedReady(false);
      revalidation.current = { version: -1, at: 0, busy: false };
      suppressHover.current = false;
      nativeHover.current = false;
      pointerInside.current = false;
      peekClock.current.clear();
      clearTimeout(dwellTimer.current);
      clearTimeout(leaveTimer.current);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requested = generation.current;
      try {
        if (acting.current) return;
        const value = await invoke<AssistieSnapshot>(
          "assistie_fixture_snapshot",
        );
        if (!disposed && generation.current === requested) {
          setSnapshot(value);
          setError(false);
        }
      } catch {
        if (!disposed && generation.current === requested) {
          setSnapshot(null);
          setError(true);
        }
      } finally {
        if (!disposed) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [visible]);

  const phase = notchPhase(snapshot, error);
  const runId = snapshot?.run_id ?? "";
  const replyCount = snapshot?.reply_count ?? snapshot?.replies.length ?? 0;
  const enabled =
    !!snapshot?.sharing &&
    ["following", "waiting"].includes(snapshot.status) &&
    !error;
  // The run is over or paused (not a passing read error): nothing new may peek.
  const ended =
    !!snapshot &&
    (!snapshot.sharing || !["following", "waiting"].includes(snapshot.status));
  const pending = snapshot?.questions.some((q) => q.status === "pending");
  const canAsk =
    enabled &&
    !pending &&
    !busy &&
    (snapshot?.questions_asked ?? snapshot?.questions.length ?? 0) <
      (snapshot?.question_limit ?? 4);

  function record(events: { n: number; action: string }[]) {
    if (events.length && feedRun.current)
      void invoke("record_notch_events", {
        runId: feedRun.current,
        events,
      }).catch(() => {});
  }
  function markSeen(numbers: number[]) {
    const fresh = numbers.filter((n) => feedNow.current.unseen.includes(n));
    if (!fresh.length) return;
    record(fresh.map((n) => ({ n, action: "seen" })));
    setFeed((value) => step(value, { type: "seen", n: fresh }));
  }

  // A run's chat starts from its newest page; the seen log says what is still unseen.
  useEffect(() => {
    if (!visible || !runId) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    feedRun.current = runId;
    lastNumber.current = 0;
    seenTimers.current.forEach(clearTimeout);
    seenTimers.current.clear();
    revalidation.current = { version: -1, at: 0, busy: false };
    setFeedReady(false);
    setItems([]);
    setMoreBefore(false);
    setNewBelow(0);
    setFeed(initialFeed());
    void Promise.all([
      invoke<number[]>("notch_seen_replies", { runId }),
      invoke<FeedPage>("assistie_notch_feed", {
        runId,
        before: null,
        after: null,
        limit: PAGE,
      }),
    ])
      .then(([seen, page]) => {
        if (disposed) return;
        const known = new Set(seen);
        const unseen = Array.from(
          { length: page.reply_count },
          (_, i) => i + 1,
        ).filter((n) => !known.has(n));
        lastNumber.current = page.reply_count;
        setItems(page.items);
        setMoreBefore(page.more_before);
        setFeed(initialFeed(unseen));
        setFeedReady(true);
      })
      .catch(() => {
        if (disposed) return;
        setError(true);
        // A failed first read must not leave the chat empty for the rest of the call.
        retry = setTimeout(() => setFeedAttempt((n) => n + 1), 2000);
      });
    return () => {
      disposed = true;
      clearTimeout(retry);
    };
  }, [visible, runId, feedAttempt]);

  // New replies: the snapshot poll is the one clock. Each poll re-checks, so a fetch that was busy,
  // failed or came back empty (sharing paused) is retried instead of skipping a reply.
  useEffect(() => {
    if (
      !feedReady ||
      !enabled ||
      replyCount <= lastNumber.current ||
      fetching.current
    )
      return;
    const run = runId;
    fetching.current = true;
    void invoke<FeedPage>("assistie_notch_feed", {
      runId: run,
      before: null,
      after: lastNumber.current,
      limit: 50,
    })
      .then((page) => {
        if (feedRun.current !== run) return;
        const fresh = page.items.filter((i) => i.n > lastNumber.current);
        if (!fresh.length) return;
        lastNumber.current = fresh[fresh.length - 1].n;
        setItems((current) => merge(current, fresh));
        if (surfaceNow.current === "open" && !atBottom.current)
          setNewBelow((count) => count + fresh.length);
        const now = Date.now();
        let next = feedNow.current;
        const events: { n: number; action: string }[] = [];
        for (const item of fresh) {
          const before = next.peek;
          next = step(next, {
            type: "arrive",
            n: item.n,
            kind: item.reply.kind === "answer" ? "answer" : "pointer",
            at: now,
            surface: surfaceNow.current,
            youSpeaking: speakingNow.current,
          } satisfies FeedEvent);
          if (surfaceNow.current === "closed")
            events.push({
              n: item.n,
              action:
                next.peek?.n === item.n && next.peek !== before
                  ? "shown"
                  : "skipped",
            });
        }
        feedNow.current = next;
        setFeed(next);
        record(events);
      })
      .catch(() => setError(true))
      .finally(() => {
        fetching.current = false;
      });
  }, [feedReady, snapshot, enabled, replyCount, runId]);

  // A corrected transcript line can revise any reply already in the chat. The snapshot cannot say
  // so: it holds only the newest replies and drops invalidated pointers. So when the transcript
  // moves, re-read the loaded replies through the feed, which rechecks each one's citations.
  useEffect(() => {
    const version = snapshot?.version;
    const check = revalidation.current;
    if (
      !feedReady ||
      !enabled ||
      version === undefined ||
      !items.length ||
      version === check.version ||
      check.busy ||
      Date.now() - check.at < PACING.revalidateMs
    )
      return;
    Object.assign(check, { version, at: Date.now(), busy: true });
    const run = runId;
    const last = items[items.length - 1].n;
    let after = items[0].n - 1;
    void (async () => {
      const fresh: FeedItem[] = [];
      while (after < last && revalidation.current === check) {
        const page = await invoke<FeedPage>("assistie_notch_feed", {
          runId: run,
          before: null,
          after,
          limit: 50,
        });
        if (!page.items.length) break;
        fresh.push(...page.items);
        after = page.items[page.items.length - 1].n;
      }
      if (revalidation.current === check)
        setItems((current) => applySourceStatus(current, fresh));
    })()
      .catch(() => {
        // Only a warning is late; the next poll tries again.
        check.version = -1;
      })
      .finally(() => {
        check.busy = false;
      });
  }, [feedReady, snapshot, enabled, items, runId]);

  // A pointer held while you talked may peek once your line is done.
  const wasSpeaking = useRef(false);
  useEffect(() => {
    if (!snapshot) return; // A failed poll says nothing about your speech.
    if (wasSpeaking.current && !speaking && !ended)
      setFeed((value) =>
        step(value, {
          type: "speechEnded",
          at: Date.now(),
          surface: surfaceNow.current,
        }),
      );
    wasSpeaking.current = speaking;
  }, [speaking, ended, snapshot]);

  // Once the run ends or sharing pauses, nothing new may peek while the notch says "Saved".
  useEffect(() => {
    if (ended) setFeed((value) => step(value, { type: "hidden" }));
  }, [ended]);

  const peekItem =
    !expanded && feed.peek
      ? items.find((item) => item.n === feed.peek?.n)
      : undefined;
  // Joining a pointer peek changes its line but not its reading time; a new peek starts fresh.
  const peekKey = feed.peek
    ? feed.peek.kind === "answer"
      ? `a${feed.peek.n}`
      : `p${feed.lastPointerPeekAt}`
    : "";
  const peeking = visible && !expanded && !!peekItem;
  const measure = useRef<HTMLSpanElement>(null);
  const [peekLines, setPeekLines] = useState(1);
  const measuredLines = useRef(1);
  const peekText = peeking ? peekItem?.reply.text : undefined;
  // The row's own margins, bullet and gap, plus the "+N" chip when it shows.
  const peekWidth =
    Math.max(geometry.camera_width + 264, 440) - (feed.peek?.extra ? 110 : 50); // Narrow on purpose: a spare line beats clipped text.
  useLayoutEffect(() => {
    if (!measure.current) return;
    const lines = Math.round(measure.current.offsetHeight / 18) || 1;
    peekClock.current.extend(lines - measuredLines.current);
    // The ref is ready before the effect that starts the reading clock runs.
    measuredLines.current = lines;
    setPeekLines(lines);
  }, [peekText, peekWidth]);

  useEffect(() => {
    if (peekKey) peekClock.current.restart(measuredLines.current);
    else peekClock.current.clear();
  }, [peekKey]);

  useEffect(() => {
    const clock = peekClock.current;
    if (!peeking) return;
    if (hovered || composing || pinned) {
      clock.pause(performance.now());
      return;
    }
    clock.resume(performance.now());
    peekTimer.current = setTimeout(() => {
      clock.clear();
      setFeed((value) => step(value, { type: "peekEnded" }));
    }, clock.left(performance.now()));
    return () => {
      clearTimeout(peekTimer.current);
      clock.pause(performance.now());
    };
  }, [peeking, peekKey, peekLines, hovered, composing, pinned]);

  // A peeked line counts as seen after its reading threshold on screen.
  const peekNumber = peeking ? feed.peek?.n : undefined;
  useEffect(() => {
    if (peekNumber === undefined) return;
    const timer = setTimeout(() => markSeen([peekNumber]), PACING.seenMs);
    return () => clearTimeout(timer);
  }, [peekNumber]);

  useEffect(
    () => () => {
      clearTimeout(dwellTimer.current);
      clearTimeout(leaveTimer.current);
      clearTimeout(peekTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!visible) return;
    void invoke("layout_assistie_notch", {
      mode: expanded ? "expanded" : peeking ? "peek" : "compact",
      lines: peekLines,
      reduceMotion,
    }).catch(() => setError(true));
  }, [visible, expanded, peeking, peekLines, reduceMotion]);

  // Open chat: a reply in view for the threshold counts as seen; scrolling past it quickly does not.
  // Timers outlive observer rebuilds, so a new reply does not restart a row already being read.
  useEffect(() => {
    const scroller = chat.current;
    const timers = seenTimers.current;
    if (!expanded || !scroller) {
      timers.forEach(clearTimeout);
      timers.clear();
      return;
    }
    // Measured directly on every scroll and resize, so the rule below is the only threshold.
    const check = () => {
      const view = scroller.getBoundingClientRect();
      scroller
        .querySelectorAll<HTMLElement>("[data-unseen]")
        .forEach((element) => {
          const n = Number(element.dataset.n);
          const row = element.getBoundingClientRect();
          const visible =
            Math.min(row.bottom, view.bottom) - Math.max(row.top, view.top);
          if (readable(row.height, visible, view.height)) {
            if (!timers.has(n))
              timers.set(
                n,
                setTimeout(() => {
                  timers.delete(n);
                  markSeen([n]);
                }, PACING.seenMs),
              );
          } else {
            clearTimeout(timers.get(n));
            timers.delete(n);
          }
        });
    };
    check();
    scroller.addEventListener("scroll", check, { passive: true });
    const resize = new ResizeObserver(check);
    resize.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", check);
      resize.disconnect();
    };
  }, [expanded, items]);
  useEffect(() => {
    const timers = seenTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Opening lands on the first unseen reply, else at the bottom.
  useLayoutEffect(() => {
    const scroller = chat.current;
    if (!expanded || !scroller) return;
    // The first unseen reply that is loaded; older unseen ones wait above, marked, for a scroll.
    const loaded = new Set(items.map((item) => item.n));
    const target =
      landing(feedNow.current) === null
        ? null
        : (feedNow.current.unseen.find((n) => loaded.has(n)) ?? null);
    const row =
      target === null
        ? null
        : scroller.querySelector<HTMLElement>(`[data-n="${target}"]`);
    if (row) scroller.scrollTop = row.offsetTop - 12;
    else scroller.scrollTop = scroller.scrollHeight;
    atBottom.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    setNewBelow(0);
  }, [expanded]);

  // Older pages keep the reader's place; new replies follow the bottom only if the reader is there.
  useLayoutEffect(() => {
    const scroller = chat.current;
    if (!scroller) return;
    if (prepend.current) {
      scroller.scrollTop =
        prepend.current.top + scroller.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (atBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [items]);

  function onChatScroll() {
    const scroller = chat.current;
    if (!scroller) return;
    atBottom.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    if (atBottom.current) setNewBelow(0);
    if (
      scroller.scrollTop < 40 &&
      moreBefore &&
      !loadingOlder.current &&
      items[0]
    ) {
      const run = runId;
      loadingOlder.current = true;
      void invoke<FeedPage>("assistie_notch_feed", {
        runId: run,
        before: items[0].n,
        after: null,
        limit: PAGE,
      })
        .then((page) => {
          if (feedRun.current !== run) return;
          prepend.current = {
            height: scroller.scrollHeight,
            top: scroller.scrollTop,
          };
          setItems((current) => merge(page.items, current));
          setMoreBefore(page.more_before);
        })
        .catch(() => setError(true))
        .finally(() => {
          loadingOlder.current = false;
        });
    }
  }

  function open() {
    setExpanded(true);
    setFeed((value) => step(value, { type: "opened" }));
  }
  function updateHover(inside: boolean, native = false) {
    // Native sampling also works over the camera gap and inactive WKWebViews.
    if (!native && nativeHover.current) return;
    if (native) nativeHover.current = true;
    if (pointerInside.current === inside) return;
    pointerInside.current = inside;
    clearTimeout(dwellTimer.current);
    clearTimeout(leaveTimer.current);
    setHovered(inside);
    if (inside) {
      if (!suppressHover.current && !interaction.current.expanded) {
        dwellTimer.current = setTimeout(() => {
          if (
            interaction.current.visible &&
            pointerInside.current &&
            !suppressHover.current
          )
            open();
        }, HOVER_DWELL_MS);
      }
    } else {
      suppressHover.current = false;
      leaveTimer.current = setTimeout(() => {
        if (
          interaction.current.expanded &&
          !interaction.current.pinned &&
          !root.current?.contains(document.activeElement)
        )
          collapse(false);
      }, LEAVE_GRACE_MS);
    }
  }
  function collapse(dismiss = true) {
    clearTimeout(dwellTimer.current);
    clearTimeout(leaveTimer.current);
    if (dismiss) {
      suppressHover.current = hovered;
      peekClock.current.clear();
      const peeked = feedNow.current.peek;
      // Dismissing a peek says "got it". Closing the chat only ends any peek kept underneath it;
      // that reply stays unseen unless the chat showed it long enough.
      if (peeked && !interaction.current.expanded) {
        record([{ n: peeked.n, action: "dismissed" }]);
        setFeed((value) => step(value, { type: "dismissed" }));
      } else setFeed((value) => step(value, { type: "peekEnded" }));
    }
    setPinned(false);
    setComposing(false);
    setExpanded(false);
    setOpenSources(new Set());
    if (root.current?.contains(document.activeElement))
      (document.activeElement as HTMLElement)?.blur();
    void invoke("edit_assistie_notch", { editing: false }).catch(() =>
      setError(true),
    );
  }
  async function act(command: string, args?: Record<string, unknown>) {
    if (acting.current) return false;
    acting.current = true;
    generation.current++;
    setBusy(true);
    try {
      setSnapshot(
        await invoke<AssistieSnapshot>(command, {
          ...args,
          runId: snapshot?.run_id,
        }),
      );
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
  async function hide() {
    collapse();
    try {
      await invoke("set_assistie_notch_visible", { visible: false });
      setVisible(false);
    } catch {
      setError(true);
    }
  }
  function pinOpen() {
    clearTimeout(dwellTimer.current);
    setPinned(true);
    open();
  }

  const unseen = feed.unseen.length;
  const newest = items[items.length - 1]?.n;
  const answered = new Set(
    items.map((item) => item.reply.question_id).filter((id) => id !== null),
  );
  const waiting = (snapshot?.questions ?? []).filter(
    (q) => q.status !== "answered" && !answered.has(q.id),
  );

  function speaker(quote: Quote) {
    if (quote.source === "you") return { tone: "you", label: t("calls.you") };
    if (quote.source === "other_audio")
      return { tone: "them", label: t("calls.notch.them") };
    return { tone: "notes", label: t("calls.notch.notes") };
  }
  function stamp(item: FeedItem) {
    const at = item.reply.received_at_ms ?? item.reply.snapshot_at_ms;
    return at
      ? new Date(at).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
  }
  /** A corrected or lost source always gets a mark. A source that only left the live window
      needs none while its saved quote is in the bubble; with no quote, say where it came from. */
  function sourceNote(reply: FeedItem["reply"]) {
    const status = reply.source_status;
    if (!status) return "";
    if (status !== "outside_window")
      return t(`calls.assistie.sourceStatus.${status}`);
    return reply.quotes.length ? "" : t("calls.assistie.earlierContext");
  }
  function terraLabel(item: FeedItem) {
    const time = stamp(item);
    return (
      <small className="chat-label terra">
        {notchProfile.displayName}
        {time && ` · ${time}`}
      </small>
    );
  }
  function bubble(item: FeedItem) {
    const { reply } = item;
    const shown = openSources.has(item.n)
      ? reply.quotes
      : reply.quotes.slice(0, 1);
    return (
      <div
        className={`chat-row terra${reply.kind === "answer" ? " answer" : ""}`}
        data-n={item.n}
        data-unseen={feed.unseen.includes(item.n) || undefined}
      >
        <div className="chat-bubble">
          <p>{reply.text}</p>
          {shown.map((quote) => {
            const who = speaker(quote);
            return (
              <blockquote key={quote.id} className={`chat-quote ${who.tone}`}>
                <small>
                  {who.label}
                  {quote.start_ms != null && ` · ${callTime(quote.start_ms)}`}
                </small>
                <span>{quote.text}</span>
              </blockquote>
            );
          })}
          {reply.quotes.length > 1 && (
            <button
              className="chat-more"
              onClick={() =>
                setOpenSources((current) => {
                  const next = new Set(current);
                  if (!next.delete(item.n)) next.add(item.n);
                  return next;
                })
              }
              aria-expanded={openSources.has(item.n)}
              aria-label={
                openSources.has(item.n)
                  ? t("calls.notch.fewerSources")
                  : t("calls.notch.moreSources", {
                      count: reply.quotes.length - 1,
                    })
              }
            >
              {openSources.has(item.n)
                ? t("calls.notch.less")
                : t("calls.notch.more", { count: reply.quotes.length - 1 })}
            </button>
          )}
        </div>
        <div className="chat-tools">
          {sourceNote(reply) && (
            <span
              className="chat-status"
              title={sourceNote(reply)}
              aria-label={sourceNote(reply)}
              role="img"
            >
              <Clock3 size={13} aria-hidden="true" />
            </span>
          )}
          {canRate(snapshot) && (
            <RatingRow
              key={`${runId}:${reply.event_id}`}
              marks={snapshot?.marks}
              reply={reply}
              withMissed={item.n === newest}
              busy={busy}
              onRate={(rating, eventId) =>
                act("rate_terra_reply", { eventId, rating, note: "" })
              }
            />
          )}
        </div>
      </div>
    );
  }
  function you(text: string, key: string, failed = false) {
    return (
      <div className="chat-row you" key={key}>
        <small className="chat-label you">{t("calls.you")}</small>
        <p className="chat-bubble">{text}</p>
        {failed && (
          <small className="chat-failed">{t("calls.notch.failed")}</small>
        )}
      </div>
    );
  }

  // Questions above their answers; consecutive pointers share one Terra label.
  const rows: JSX.Element[] = [];
  items.forEach((item, index) => {
    const previous = items[index - 1];
    if (item.reply.kind === "answer" && item.question)
      rows.push(you(item.question.text, `q${item.n}`));
    const joined =
      item.reply.kind !== "answer" &&
      previous &&
      previous.reply.kind !== "answer";
    rows.push(
      <div className="chat-group" key={item.n}>
        {!joined && terraLabel(item)}
        {bubble(item)}
      </div>,
    );
  });
  waiting.forEach((q) =>
    rows.push(you(q.text, `w${q.id}`, q.status === "failed")),
  );
  if (pending)
    rows.push(
      <div className="chat-row terra" key="thinking">
        <p
          className="chat-bubble chat-typing"
          role="img"
          aria-label={t("calls.notch.thinking")}
        >
          <ThinkingOrb
            className="terra-orb"
            state="working"
            size={20}
            theme="dark"
            aria-hidden="true"
          />
        </p>
      </div>,
    );

  const mark =
    phase === "stopped" ? (
      <Check
        className="terra-check"
        size={15}
        strokeWidth={2.25}
        aria-hidden="true"
      />
    ) : phase === "thinking" || (thinking && phase === "following") ? (
      <ThinkingOrb
        className="terra-orb"
        state="working"
        size={20}
        theme="dark"
        aria-hidden="true"
      />
    ) : (
      <span className="terra-mark" aria-hidden="true" />
    );
  const announcement =
    phase === "stopped"
      ? t("calls.notch.saved")
      : unseen > 0 && !expanded
        ? t("calls.notch.unseen", { count: unseen })
        : t(`calls.notch.${phase}`);

  return (
    <section
      ref={root}
      className={`assistie-notch ${expanded ? "expanded" : peeking ? "peek" : "compact"}`}
      style={
        {
          "--camera-width": `${geometry.camera_width}px`,
          "--header-height": `${geometry.header_height}px`,
          "--surface-width": `${geometry.width}px`,
        } as CSSProperties
      }
      data-phase={phase}
      aria-label={t("calls.notch.title")}
      onMouseEnter={() => updateHover(true)}
      onMouseLeave={() => updateHover(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (expanded || peeking)) {
          event.preventDefault();
          collapse();
        }
      }}
    >
      {expanded ? (
        <div className="notch-handle">
          <span className="notch-identity">
            {mark}
            <strong>{notchProfile.displayName}</strong>
          </span>
          <span className="notch-camera" aria-hidden="true" />
          <span className="notch-controls">
            <button
              onClick={() => collapse()}
              aria-label={t("calls.notch.collapse")}
            >
              <ChevronUp size={16} />
            </button>
            <button
              onClick={() => setPinned(!pinned)}
              aria-pressed={pinned}
              aria-label={t(`calls.notch.${pinned ? "unpin" : "pin"}`)}
            >
              {pinned ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
            <button
              onClick={() => void hide()}
              aria-label={t("calls.notch.hide")}
            >
              <X size={16} />
            </button>
          </span>
        </div>
      ) : (
        <button
          className="notch-handle"
          onClick={pinOpen}
          aria-expanded={false}
          aria-controls="notch-detail"
          aria-label={t("calls.notch.focus")}
        >
          <span className="notch-identity">{mark}</span>
          <span className="notch-camera" aria-hidden="true" />
          <span className="notch-status">
            {phase === "stopped" ? (
              <span className="notch-saved" aria-hidden="true">
                {t("calls.notch.saved")}
              </span>
            ) : (
              <NotchWave />
            )}
          </span>
        </button>
      )}
      <span className="notch-hidden" role="status">
        {announcement}
      </span>
      {peekText && (
        <span
          ref={measure}
          className="notch-measure"
          aria-hidden="true"
          style={{ width: peekWidth }}
        >
          {peekText}
        </span>
      )}
      {peeking && peekItem && feed.peek && (
        <p
          className={`notch-line${peekItem.reply.source_status ? " earlier" : ""}`}
          key={peekKey}
        >
          <span className="notch-line-text">{peekItem.reply.text}</span>
          {feed.peek.extra > 0 && (
            <span className="notch-more">
              {t("calls.notch.more", { count: feed.peek.extra })}
            </span>
          )}
        </p>
      )}
      <div
        id="notch-detail"
        className="notch-detail"
        aria-hidden={!expanded}
        {...(!expanded ? { inert: "" } : {})}
      >
        {/* Focusable so a long chat can be scrolled by keyboard. A plain click on empty space means
            "let me type", so it moves the caret to the ask field; selecting text or pressing a
            control is left alone. */}
        <div
          ref={chat}
          className="notch-chat"
          tabIndex={0}
          role="log"
          aria-label={t("calls.notch.note")}
          onScroll={onChatScroll}
          onClick={(event) => {
            if (
              !(event.target as HTMLElement).closest("button") &&
              window.getSelection()?.isCollapsed !== false
            )
              askField.current?.focus();
          }}
        >
          {rows.length ? (
            rows
          ) : (
            <p className="notch-empty">
              {t(
                `calls.notch.${snapshot?.call_id && ["following", "waiting", "unavailable"].includes(phase) ? `call${phase.charAt(0).toUpperCase()}${phase.slice(1)}` : phase}Help`,
              )}
            </p>
          )}
        </div>
        {newBelow > 0 && (
          <button
            className="chat-new"
            onClick={() => {
              const scroller = chat.current;
              if (scroller) scroller.scrollTop = scroller.scrollHeight;
              setNewBelow(0);
            }}
          >
            <ArrowDown size={13} aria-hidden="true" />
            {t("calls.notch.newBelow", { count: newBelow })}
          </button>
        )}
        <div className="notch-bottom">
          <button
            className="notch-round"
            disabled={!enabled || busy}
            onClick={() =>
              void act("control_assistie_fixture", {
                sharing: true,
                proactive: !snapshot?.proactive,
              })
            }
            aria-label={t(
              `calls.notch.${snapshot?.proactive ? "pointersOff" : "pointersOn"}`,
            )}
            title={t(
              `calls.notch.${snapshot?.proactive ? "pointersOff" : "pointersOn"}`,
            )}
          >
            {snapshot?.proactive ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canAsk && question.trim())
                void act("ask_assistie_fixture", { question }).then((ok) => {
                  if (ok) setQuestion("");
                });
            }}
          >
            <input
              ref={askField}
              aria-label={t("calls.notch.ask")}
              placeholder={t("calls.notch.ask")}
              value={question}
              maxLength={800}
              disabled={!canAsk || !expanded}
              onChange={(event) => setQuestion(event.target.value)}
              onFocus={() => {
                setComposing(true);
                setPinned(true);
                void invoke("edit_assistie_notch", { editing: true }).catch(
                  () => setError(true),
                );
              }}
              onBlur={() => setComposing(false)}
            />
            <button
              disabled={!canAsk || !question.trim()}
              aria-label={t("calls.notch.send")}
            >
              <ArrowUp size={15} />
            </button>
          </form>
          <button
            className="notch-round"
            disabled={!enabled || busy}
            onClick={() => {
              collapse();
              void act("stop_assistie_fixture");
            }}
            aria-label={t("calls.notch.stop")}
            title={t("calls.notch.stop")}
          >
            <Square size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}
