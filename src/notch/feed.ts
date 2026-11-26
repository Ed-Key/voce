import type { AssistieSnapshot } from "../components/calls/AssistiePanel";

/** Terra decides what to say; the notch decides when it shows. Every number here is a tunable default. */
export const PACING = {
  /** At most one pointer peek per gap; pointers inside it only raise the unseen count. */
  // Every reply shows when it lands; raise this if pointers get noisy.
  pointerGapMs: 0,
  /** An item counts as seen after this long on screen. */
  seenMs: 1_500,
  /** ...with this share of it in view, or of the chat filled by it when it is taller than the chat. */
  seenShare: 0.6,
  /** Loaded replies are rechecked against the transcript at most this often. */
  revalidateMs: 5_000,
  /** How long "Saved" stays after the call ends. Kept in step with SAVED_HIDE_MS in notch.rs. */
  savedMs: 4_000,
} as const;

export type Kind = "answer" | "pointer";

export interface Feed {
  /** The reply shown as the one-line peek, and how many pointers it stands for beyond itself. */
  peek: { n: number; kind: Kind; extra: number } | null;
  lastPointerPeekAt: number | null;
  /** A pointer waiting for your own line to finish before it may peek. */
  held: number | null;
  /** Pointers that arrived without peeking since the last pointer peek. */
  pending: number;
  /** Reply numbers not yet seen, ascending. */
  unseen: number[];
}

/** Where the notch is, as far as peeking is concerned: open and pinned both mean you can already see the chat. */
export type Surface = "closed" | "open" | "hidden";

export type FeedEvent =
  | {
      type: "arrive";
      n: number;
      kind: Kind;
      at: number;
      surface: Surface;
      youSpeaking: boolean;
    }
  | { type: "speechEnded"; at: number; surface: Surface }
  | { type: "peekEnded" }
  | { type: "opened" }
  | { type: "dismissed" }
  | { type: "hidden" }
  | { type: "seen"; n: number[] };

export function initialFeed(unseen: number[] = []): Feed {
  return {
    peek: null,
    lastPointerPeekAt: null,
    held: null,
    pending: 0,
    unseen: [...new Set(unseen)].sort((a, b) => a - b),
  };
}

function gapOpen(feed: Feed, at: number, gapMs: number) {
  return (
    feed.lastPointerPeekAt === null || at - feed.lastPointerPeekAt >= gapMs
  );
}

function pointerPeek(feed: Feed, n: number, at: number): Feed {
  return {
    ...feed,
    peek: { n, kind: "pointer", extra: feed.pending },
    lastPointerPeekAt: at,
    pending: 0,
    held: null,
  };
}

export function step(
  feed: Feed,
  event: FeedEvent,
  gapMs: number = PACING.pointerGapMs,
): Feed {
  switch (event.type) {
    case "arrive": {
      const unseen = feed.unseen.includes(event.n)
        ? feed.unseen
        : [...feed.unseen, event.n].sort((a, b) => a - b);
      const next = { ...feed, unseen };
      if (event.surface !== "closed") return { ...next, held: null };
      if (event.kind === "answer")
        // You asked, so you are waiting: an answer always peeks and outranks any pointer.
        return {
          ...next,
          peek: { n: event.n, kind: "answer", extra: 0 },
          held: null,
          pending: next.pending + (next.held === null ? 0 : 1),
        };
      if (next.peek?.kind === "answer")
        return { ...next, pending: next.pending + 1 };
      if (next.peek?.kind === "pointer")
        // While you talk the line on screen stays put; the newcomer only adds to "+N".
        return {
          ...next,
          peek: {
            ...next.peek,
            n: event.youSpeaking ? next.peek.n : event.n,
            extra: next.peek.extra + 1,
          },
        };
      if (event.youSpeaking)
        return {
          ...next,
          held: event.n,
          pending: next.pending + (next.held === null ? 0 : 1),
        };
      if (gapOpen(next, event.at, gapMs))
        return pointerPeek(next, event.n, event.at);
      return { ...next, pending: next.pending + 1 };
    }
    case "speechEnded": {
      if (feed.held === null) return feed;
      if (
        event.surface === "closed" &&
        !feed.peek &&
        gapOpen(feed, event.at, gapMs)
      )
        return pointerPeek(feed, feed.held, event.at);
      return { ...feed, held: null, pending: feed.pending + 1 };
    }
    case "peekEnded":
      return { ...feed, peek: null };
    case "opened":
      // The chat shows everything, so no backlog is left to announce. The peek stays: if the
      // pointer leaves without a dismissal, it comes back with the rest of its reading time.
      return { ...feed, held: null, pending: 0 };
    case "dismissed":
      // Closing a peek on purpose says "got it", whatever its reading time.
      return feed.peek
        ? {
            ...feed,
            peek: null,
            unseen: feed.unseen.filter((n) => n !== feed.peek!.n),
          }
        : feed;
    case "hidden":
      return { ...feed, peek: null, held: null };
    case "seen":
      return {
        ...feed,
        unseen: feed.unseen.filter((n) => !event.n.includes(n)),
      };
  }
}

/** Opening lands on the first unseen reply, or at the bottom (null) when everything was seen. */
export function landing(feed: Feed) {
  return feed.unseen[0] ?? null;
}

/** One page of `assistie_notch_feed`: replies numbered like the bridge's reply files, oldest first. */
export interface FeedItem {
  n: number;
  reply: AssistieSnapshot["replies"][number];
  question: AssistieSnapshot["questions"][number] | null;
}
export interface FeedPage {
  run_id: string;
  reply_count: number;
  items: FeedItem[];
  more_before: boolean;
}

/** Is enough of a row in view to read? A row taller than the chat can only ever fill the chat. */
export function readable(
  rowHeight: number,
  visibleHeight: number,
  viewHeight: number,
) {
  return (
    rowHeight > 0 &&
    viewHeight > 0 &&
    visibleHeight >= PACING.seenShare * Math.min(rowHeight, viewHeight)
  );
}

/** Folds rechecked citations into the loaded replies; the same array back when nothing changed. */
export function applySourceStatus(items: FeedItem[], fresh: FeedItem[]) {
  const statuses = new Map(
    fresh.map((item) => [item.n, item.reply.source_status ?? null]),
  );
  let changed = false;
  const next = items.map((item) => {
    const status = statuses.get(item.n);
    if (status === undefined || status === (item.reply.source_status ?? null))
      return item;
    changed = true;
    return { ...item, reply: { ...item.reply, source_status: status } };
  });
  return changed ? next : items;
}

/** Merges a page into the loaded items by reply number, so a page read twice never duplicates. */
export function merge(items: FeedItem[], page: FeedItem[]) {
  const byNumber = new Map(items.map((item) => [item.n, item]));
  for (const item of page) byNumber.set(item.n, item);
  return [...byNumber.values()].sort((a, b) => a.n - b.n);
}
