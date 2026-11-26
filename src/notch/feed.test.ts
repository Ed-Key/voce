import assert from "node:assert/strict";
import {
  initialFeed,
  landing,
  PACING,
  step as stepWithGap,
  type Feed,
  type Kind,
  type Surface,
} from "./feed";

// Most checks below pin the pacing gap at 20 s, so they test the gap itself; the default is tested last.
const GAP = 20_000;
const step = (feed: Feed, event: Parameters<typeof stepWithGap>[1]) =>
  stepWithGap(feed, event, GAP);
const arrive = (
  feed: Feed,
  n: number,
  kind: Kind,
  at: number,
  surface: Surface = "closed",
  youSpeaking = false,
) => step(feed, { type: "arrive", n, kind, at, surface, youSpeaking });
let checks = 0;
function check(name: string, run: () => void) {
  run();
  checks++;
  console.log(`ok ${name}`);
}

// One test per row of the behavior table for the notch feed.
check("answer arrives: closed peeks it, and it replaces a pointer peek", () => {
  const closed = arrive(initialFeed(), 1, "answer", 0);
  assert.deepEqual(closed.peek, { n: 1, kind: "answer", extra: 0 });
  const overPointer = arrive(
    arrive(initialFeed(), 1, "pointer", 0),
    2,
    "answer",
    1000,
  );
  assert.deepEqual(overPointer.peek, { n: 2, kind: "answer", extra: 0 });
});
check("answer arrives: open and pinned append it without a peek", () => {
  const open = arrive(initialFeed(), 1, "answer", 0, "open");
  assert.equal(open.peek, null);
  assert.deepEqual(open.unseen, [1]);
});
check(
  "pointer arrives: closed peeks when the gap allows, else only counts",
  () => {
    const first = arrive(initialFeed(), 1, "pointer", 0);
    assert.deepEqual(first.peek, { n: 1, kind: "pointer", extra: 0 });
    const later = arrive(
      step(first, { type: "peekEnded" }),
      2,
      "pointer",
      8000,
    );
    assert.equal(later.peek, null);
    assert.deepEqual(later.unseen, [1, 2]);
  },
);
check("pointer arrives: a pointer peek shows the newest line with +1", () => {
  const joined = arrive(
    arrive(initialFeed(), 1, "pointer", 0),
    2,
    "pointer",
    3000,
  );
  assert.deepEqual(joined.peek, { n: 2, kind: "pointer", extra: 1 });
  assert.equal(
    joined.lastPointerPeekAt,
    0,
    "joining does not restart the pacing gap",
  );
});
check("pointer arrives: an answer peek is never replaced by a pointer", () => {
  const answer = arrive(
    arrive(initialFeed(), 1, "answer", 0),
    2,
    "pointer",
    1000,
  );
  assert.deepEqual(answer.peek, { n: 1, kind: "answer", extra: 0 });
  assert.deepEqual(answer.unseen, [1, 2]);
});
check("pointer arrives: open appends it unseen without a peek", () => {
  const open = arrive(initialFeed([1]), 2, "pointer", 0, "open");
  assert.equal(open.peek, null);
  assert.deepEqual(open.unseen, [1, 2]);
});
check(
  "hover opens on the first unseen reply, or the bottom when all are seen",
  () => {
    const opened = step(arrive(initialFeed([3, 5]), 6, "pointer", 0), {
      type: "opened",
    });
    assert.deepEqual(
      opened.peek,
      { n: 6, kind: "pointer", extra: 0 },
      "leaving without a dismissal resumes the peek",
    );
    assert.equal(landing(opened), 3);
    assert.equal(landing(initialFeed()), null);
  },
);
check(
  "escape or chevron marks the peeked reply seen at any reading time",
  () => {
    const dismissed = step(arrive(initialFeed([1]), 2, "pointer", 0), {
      type: "dismissed",
    });
    assert.equal(dismissed.peek, null);
    assert.deepEqual(dismissed.unseen, [1]);
  },
);
check("hide: replies keep counting and nothing peeks", () => {
  const hidden = arrive(
    step(arrive(initialFeed(), 1, "pointer", 0), { type: "hidden" }),
    2,
    "answer",
    1000,
    "hidden",
  );
  assert.equal(hidden.peek, null);
  assert.deepEqual(hidden.unseen, [1, 2]);
  assert.deepEqual(
    initialFeed([2, 1, 2]).unseen,
    [1, 2],
    "a reload rebuilds the same set from the log",
  );
});
check("you are talking: a pointer waits for your line, then peeks", () => {
  const held = arrive(initialFeed(), 1, "pointer", 0, "closed", true);
  assert.equal(held.peek, null);
  assert.equal(held.held, 1);
  const shown = step(held, {
    type: "speechEnded",
    at: 2000,
    surface: "closed",
  });
  assert.deepEqual(shown.peek, { n: 1, kind: "pointer", extra: 0 });
});
check(
  "you are talking: a pointer arriving during a pointer peek keeps the line and adds +1",
  () => {
    const joined = arrive(
      arrive(initialFeed(), 1, "pointer", 0),
      2,
      "pointer",
      1000,
      "closed",
      true,
    );
    assert.deepEqual(joined.peek, { n: 1, kind: "pointer", extra: 1 });
  },
);
check(
  "you are talking: a newer pointer replaces the held one, which only counts",
  () => {
    const replaced = arrive(
      arrive(initialFeed(), 1, "pointer", 0, "closed", true),
      2,
      "pointer",
      1000,
      "closed",
      true,
    );
    assert.equal(replaced.held, 2);
    const shown = step(replaced, {
      type: "speechEnded",
      at: 2000,
      surface: "closed",
    });
    assert.deepEqual(shown.peek, { n: 2, kind: "pointer", extra: 1 });
  },
);
check("call ends: any peek or held pointer is dropped", () => {
  const peeking = arrive(initialFeed(), 1, "pointer", 0);
  assert.ok(peeking.peek);
  const ended = step(arrive(peeking, 2, "pointer", 1000, "closed", true), {
    type: "hidden",
  });
  assert.equal(ended.peek, null);
  const held = step(arrive(initialFeed(), 1, "pointer", 0, "closed", true), {
    type: "hidden",
  });
  assert.equal(held.held, null);
  assert.equal(PACING.savedMs, 4000);
});

// Pacing and seen.
check("four pointers within 30 s give two peeks, the second showing +2", () => {
  let feed = initialFeed();
  let peeks = 0;
  for (const [n, at] of [
    [1, 0],
    [2, 8000],
    [3, 15000],
    [4, 25000],
  ] as const) {
    feed = arrive(feed, n, "pointer", at);
    if (feed.peek?.n === n && feed.lastPointerPeekAt === at) peeks++;
    if (at === 0) feed = step(feed, { type: "peekEnded" });
  }
  assert.equal(peeks, 2);
  assert.deepEqual(feed.peek, { n: 4, kind: "pointer", extra: 2 });
});
check("an answer inside the pointer gap peeks at once", () => {
  const feed = arrive(
    step(arrive(initialFeed(), 1, "pointer", 0), { type: "peekEnded" }),
    2,
    "answer",
    5000,
  );
  assert.deepEqual(feed.peek, { n: 2, kind: "answer", extra: 0 });
});
check("a held pointer still waits for the gap after your line ends", () => {
  const first = step(arrive(initialFeed(), 1, "pointer", 0), {
    type: "peekEnded",
  });
  const ended = step(arrive(first, 2, "pointer", 5000, "closed", true), {
    type: "speechEnded",
    at: 9000,
    surface: "closed",
  });
  assert.equal(ended.peek, null);
  assert.equal(ended.held, null);
  assert.equal(ended.pending, 1);
});
check("seen removes only the replies it names", () => {
  const feed = step(initialFeed([1, 2, 3]), { type: "seen", n: [1, 3] });
  assert.deepEqual(feed.unseen, [2]);
});
check("opening clears the +N backlog so the next peek starts fresh", () => {
  const backlog = arrive(
    step(arrive(initialFeed(), 1, "pointer", 0), { type: "peekEnded" }),
    2,
    "pointer",
    5000,
  );
  const reopened = arrive(
    step(backlog, { type: "opened" }),
    3,
    "pointer",
    30000,
  );
  assert.deepEqual(reopened.peek, { n: 3, kind: "pointer", extra: 0 });
});

check(
  "default pacing: every pointer shows as it lands, joining a peek still on screen",
  () => {
    const go = (feed: Feed, n: number, at: number) =>
      stepWithGap(feed, {
        type: "arrive",
        n,
        kind: "pointer",
        at,
        surface: "closed",
        youSpeaking: false,
      });
    let feed = go(initialFeed(), 1, 0);
    assert.deepEqual(feed.peek, { n: 1, kind: "pointer", extra: 0 });
    feed = stepWithGap(feed, { type: "peekEnded" });
    feed = go(feed, 2, 3000);
    assert.deepEqual(
      feed.peek,
      { n: 2, kind: "pointer", extra: 0 },
      "no 20 s wait",
    );
    feed = go(feed, 3, 4000);
    assert.deepEqual(feed.peek, { n: 3, kind: "pointer", extra: 1 });
  },
);

check(
  "readable: a sliver is not, most of a row is, a tall row counts by the chat it fills",
  () => {
    assert.equal(readable(50, 10, 300), false, "a clipped row");
    assert.equal(readable(50, 29, 300), false, "just under 60%");
    assert.equal(readable(50, 30, 300), true, "60% of the row");
    assert.equal(readable(500, 300, 300), true, "a tall row filling the chat");
    assert.equal(
      readable(500, 200, 300),
      true,
      "a tall row across most of the chat",
    );
    assert.equal(readable(500, 100, 300), false, "the end of a tall row");
    assert.equal(readable(0, 0, 300), false, "a row with no size");
  },
);
check(
  "applySourceStatus: updates what changed, leaves the rest, keeps the array when nothing did",
  () => {
    const row = (n: number, source_status?: "revised" | null) =>
      ({
        n,
        reply: {
          event_id: `e${n}`,
          question_id: null,
          kind: "pointer",
          version: 1,
          text: "",
          quotes: [],
          source_status,
        },
        question: null,
      }) as FeedItem;
    const items = [row(1), row(2, "revised"), row(3)];
    assert.equal(
      applySourceStatus(items, [row(1), row(2, "revised")]),
      items,
      "no change, same array",
    );
    const next = applySourceStatus(items, [row(1, "revised"), row(2)]);
    assert.deepEqual(
      next.map((i) => i.reply.source_status),
      ["revised", null, undefined],
    );
    assert.equal(
      next[2],
      items[2],
      "a reply the page did not cover is untouched",
    );
  },
);

console.log(`Notch feed: ${checks} checks passed`);

import { applySourceStatus, merge, readable, type FeedItem } from "./feed";
const item = (n: number) =>
  ({
    n,
    reply: {
      event_id: `e${n}`,
      question_id: null,
      kind: "pointer",
      version: 1,
      text: `${n}`,
      quotes: [],
    },
    question: null,
  }) as FeedItem;
assert.deepEqual(
  merge([item(2), item(3)], [item(3), item(4), item(1)]).map((i) => i.n),
  [1, 2, 3, 4],
  "a page read twice never duplicates and keeps order",
);
console.log("Feed merge: 1 assertion passed");
