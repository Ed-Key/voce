// Replays one call's journals on the System map and the Terra view. Imperative on purpose: a call has over a thousand
// lines and this redraws every frame while playing. Meeting text only ever goes in through textContent.

export interface Revision {
  epoch_ms: number;
  stage: string;
  text: string;
  audio_ms: number[] | null;
}
export interface Line {
  source: string | null;
  revisions: Revision[];
  dropped: { epoch_ms: number; reason: string } | null;
}
export interface Tokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
export interface Turn {
  terra_run: string;
  event_id: string;
  kind: string;
  question: string | null;
  event_ms: number;
  request_ms: number | null;
  lines_sent: { id: string; text: string }[];
  output_ms: number | null;
  first_text_ms: number | null;
  raw: string | null;
  settle_ms: number | null;
  reason: string | null;
  why: string | null;
  payload: { text: string; sources: string[] } | null;
  tokens: Tokens | null;
  message?: string | null;
  sent_kind?: string;
  complete: boolean;
}
export interface Reply {
  event_id: string;
  terra_run: string;
  text: string;
  sources: unknown;
  received_at_ms: number;
}
export interface ObservatoryData {
  call: { started_ms: number; ended_ms: number };
  lines: Record<string, Line>;
  engine: { epoch_ms: number; event: string; reason: string | null }[];
  turns: Turn[];
  sessions: { model: string; effort: string; brief: string }[];
  replies: Reply[];
  problems: string[];
}

type Translate = (key: string, values?: Record<string, unknown>) => string;
type Shown = { id: string; line: Line; rev: Revision };
interface Moment {
  shown: Shown[];
  read: Set<string>;
  lastRead: string | null;
  active: Turn | undefined;
  done: Turn[];
}
interface Bead {
  path: string;
  who: string;
  t0: number;
  d: number;
  to?: string;
}
interface LineDom {
  row: HTMLElement;
  said: HTMLElement;
  bubble: HTMLButtonElement;
  trip: HTMLElement;
  ticks: HTMLElement;
  text: string;
  key: string;
  tripKey: string;
}

const SVG = "http://www.w3.org/2000/svg";
// Beads for a batch of new log rows, staggered so a live page shows them flowing rather than all at once.
const LIVE_BEADS = 24;
const LIVE_STAGGER_MS = 60;
const NODES = [
  "you",
  "them",
  "echo",
  "engine",
  "feed",
  "agent",
  "notch",
  "brief",
];
const SPEEDS: Record<number, number> = { 1: 2, 2: 4, 4: 8, 8: 0.5, 0.5: 1 };
const lineId = (id: string) => id.replace(/^t-/, "");
const reasonOf = (turn: Turn) =>
  (turn.complete ? turn.reason : "incomplete") ?? "incomplete";
const turnKey = (turn: Turn) => `${turn.terra_run}/${turn.event_id}`;
const before = (ms: number | null, now: number): ms is number =>
  ms !== null && ms <= now;

export function clock(ms: number) {
  const seconds = Math.max(0, ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function fine(ms: number) {
  const seconds = Math.max(0, ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}
function phase(turn: Turn | undefined, now: number) {
  if (!turn) return "waiting";
  if (turn.sent_kind === "buffered") return "reading";
  if (!before(turn.output_ms, now))
    return before(turn.first_text_ms, now) ? "replying" : "thinking";
  return "settling";
}

/** Ordered lines and turns, indexed once so a frame stays cheap on a long call. */
export function prepare(data: ObservatoryData) {
  const lines = Object.entries(data.lines)
    .filter(([, line]) => line.revisions.length)
    .map(([id, line]) => ({
      id,
      line,
      start: line.revisions[0].audio_ms?.[0] ?? 0,
    }))
    .sort(
      (a, b) =>
        a.start - b.start ||
        a.line.revisions[0].epoch_ms - b.line.revisions[0].epoch_ms,
    );
  const turns = data.turns.filter(
    (turn) => turn.kind !== "transcript" || turn.lines_sent.length,
  );
  const order = new Map(lines.map(({ id }, index) => [id, index]));
  const byNewestLine = new Map<string, Turn[]>();
  const firstRead = new Map<string, Turn>();
  for (const turn of turns) {
    let newest = -1;
    for (const { id } of turn.lines_sent) {
      const plain = lineId(id);
      if (!firstRead.has(plain)) firstRead.set(plain, turn);
      newest = Math.max(newest, order.get(plain) ?? -1);
    }
    if (newest < 0) continue;
    const key = lines[newest].id;
    byNewestLine.set(key, [...(byNewestLine.get(key) ?? []), turn]);
  }
  return { lines, turns, byNewestLine, firstRead };
}

/** Everything true at one moment of the call. */
export function momentAt(
  prepared: ReturnType<typeof prepare>,
  now: number,
): Moment {
  const shown: Shown[] = [];
  for (const { id, line } of prepared.lines) {
    let rev: Revision | null = null;
    for (const r of line.revisions) {
      if (r.epoch_ms > now) break;
      rev = r;
    }
    // A restart can drop a line and later finish it under the same id: only a drop after its latest text hides it.
    const dropped =
      line.dropped &&
      line.dropped.epoch_ms <= now &&
      rev &&
      rev.epoch_ms <= line.dropped.epoch_ms;
    if (rev && !dropped) shown.push({ id, line, rev });
  }
  const read = new Set<string>();
  for (const turn of prepared.turns)
    if (before(turn.request_ms, now))
      for (const sent of turn.lines_sent) read.add(lineId(sent.id));
  let lastRead: string | null = null;
  for (const item of shown) if (read.has(item.id)) lastRead = item.id;
  return {
    shown,
    read,
    lastRead,
    active: prepared.turns.find(
      (turn) => before(turn.request_ms, now) && !before(turn.settle_ms, now),
    ),
    done: prepared.turns.filter((turn) => before(turn.settle_ms, now)),
  };
}

export function createPlayer(
  root: HTMLElement,
  data: ObservatoryData,
  t: Translate,
  onOpenTerra: () => void,
  following = false,
) {
  let live = following;
  let prepared = prepare(data);
  let { lines, turns, byNewestLine, firstRead } = prepared;
  const start = data.call.started_ms;
  const finish = () =>
    live ? Date.now() : Math.max(data.call.ended_ms + 2000, start + 1000);
  let end = finish();
  let session = data.sessions[0];
  const part = <T extends Element = HTMLElement>(name: string) =>
    root.querySelector(`[data-o="${name}"]`) as T;
  const icon = (name: string) =>
    (part(`icon-${name}`).firstElementChild as Element).cloneNode(true);
  const element = (tag: string, className = "", text?: string) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const label = (turn: Turn) =>
    t(`calls.observatory.verdict.${reasonOf(turn)}`);

  const beadEvents = () => {
    const events: { ms: number; kind: string; who?: string; n?: number }[] = [];
    for (const { line } of lines)
      for (const r of line.revisions)
        events.push({
          ms: r.epoch_ms,
          kind: "rev",
          who: line.source === "you" ? "you" : "them",
        });
    for (const turn of turns) {
      if (turn.request_ms)
        events.push({
          ms: turn.request_ms,
          kind: "req",
          n: Math.min(6, turn.lines_sent.length),
        });
      if (turn.reason === "published" && turn.settle_ms)
        events.push({ ms: turn.settle_ms, kind: "pub" });
    }
    events.sort((a, b) => a.ms - b.ms);
    return events;
  };
  let events = beadEvents();

  let now = end;
  let playing = live;
  let speed = 1;
  let view = "system";
  let last = 0;
  let frame = 0;
  let cursor = events.findIndex((event) => event.ms > now);
  if (cursor < 0) cursor = events.length;
  let beads: Bead[] = [];
  let selectedLine: string | null = null;
  let selectedTurn: Turn | null = null;
  let deskKey = "";
  const flashes: Record<string, number> = {};
  const lineDom = new Map<string, LineDom>();
  const transcript = part("transcript");
  const scrub = part<HTMLInputElement>("scrub");

  function seek(to: number) {
    now = Math.max(start, Math.min(end, to));
    beads = [];
    cursor = events.findIndex((event) => event.ms > now);
    if (cursor < 0) cursor = events.length;
    wake();
  }
  function spawn() {
    // Live rows arrive already in the past, so they travel from now.
    const fresh = live ? events.slice(cursor).slice(-LIVE_BEADS) : [];
    if (live) cursor = events.length;
    for (const [index, row] of fresh.entries())
      spawnBead({ ...row, ms: now + index * LIVE_STAGGER_MS });
    while (cursor < events.length && events[cursor].ms <= now)
      spawnBead(events[cursor++]);
  }
  function spawnBead(event: {
    ms: number;
    kind: string;
    who?: string;
    n?: number;
  }) {
    if (event.kind === "rev" && event.who === "you")
      beads.push(
        { path: "p-mic-echo", who: "you", t0: event.ms, d: 350, to: "echo" },
        {
          path: "p-echo-engine",
          who: "you",
          t0: event.ms + 350,
          d: 450,
          to: "engine",
        },
        {
          path: "p-engine-feed",
          who: "you",
          t0: event.ms + 800,
          d: 350,
          to: "feed",
        },
      );
    if (event.kind === "rev" && event.who === "them")
      beads.push(
        {
          path: "p-them-engine",
          who: "them",
          t0: event.ms,
          d: 800,
          to: "engine",
        },
        {
          path: "p-engine-feed",
          who: "them",
          t0: event.ms + 800,
          d: 350,
          to: "feed",
        },
      );
    if (event.kind === "req")
      for (let k = 0; k < Math.max(1, event.n ?? 1); k++)
        beads.push({
          path: "p-feed-agent",
          who: "agent",
          t0: event.ms + k * 60,
          d: 600,
          to: "agent",
        });
    if (event.kind === "pub")
      beads.push({
        path: "p-agent-notch",
        who: "agent",
        t0: event.ms,
        d: 700,
        to: "notch",
      });
  }

  // ---- System map ---------------------------------------------------------------------------
  const nodes = Object.fromEntries(
    NODES.map((key) => [key, part<HTMLElement>(`node-${key}`)]),
  );
  const stats = Object.fromEntries(
    NODES.map((key) => [key, part(`stat-${key}`)]),
  );
  const badge = part("badge");
  const layer = part<SVGGElement>("beads");
  const set = (node: Element, text: string) => {
    if (node.textContent !== text) node.textContent = text;
  };
  function dot(
    x: number,
    y: number,
    r: number,
    fill: string,
    opacity: string,
    glow: boolean,
  ) {
    const circle = document.createElementNS(SVG, "circle");
    circle.setAttribute("cx", String(x));
    circle.setAttribute("cy", String(y));
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", fill);
    circle.setAttribute("opacity", opacity);
    if (glow) circle.setAttribute("filter", "url(#obs-glow)");
    layer.append(circle);
  }
  function drawMap(moment: Moment) {
    const speaking = (source: string) =>
      lines.some(
        ({ line }) =>
          line.source === source &&
          line.revisions.some(
            (r) => r.epoch_ms <= now && r.epoch_ms > now - 1200,
          ),
      );
    const engine = data.engine.filter((e) => e.epoch_ms <= now).pop();
    const failed = !!engine && /failure|fallback/.test(engine.event);
    const you = speaking("you");
    const them = speaking("other_audio");
    const removed = lines.filter(
      ({ line }) =>
        line.dropped?.reason === "echo" && line.dropped.epoch_ms <= now,
    ).length;
    set(stats.you, t(`calls.observatory.${you ? "speaking" : "quiet"}`));
    set(stats.them, t(`calls.observatory.${them ? "speaking" : "quiet"}`));
    set(stats.echo, t("calls.observatory.removed", { count: removed }));
    set(
      stats.engine,
      t(
        `calls.observatory.${!engine ? "starting" : failed ? "engineFailed" : "running"}`,
      ),
    );
    set(
      stats.feed,
      t("calls.observatory.lineCount", { count: moment.shown.length }),
    );
    set(stats.agent, t(`calls.observatory.phase.${phase(moment.active, now)}`));
    set(
      stats.notch,
      t("calls.observatory.shown", {
        count: moment.done.filter((turn) => turn.reason === "published").length,
      }),
    );
    set(
      stats.brief,
      session?.brief
        ? `${(new Blob([session.brief]).size / 1024).toFixed(1)} KB`
        : t("calls.observatory.none"),
    );
    const clockNow = performance.now();
    for (const key of NODES)
      nodes[key].classList.toggle(
        "flash",
        clockNow - (flashes[key] ?? -1e9) < 450,
      );
    nodes.engine.classList.toggle("fail", failed);
    nodes.agent.classList.toggle("busy", !!moment.active && !reduced);
    const unread = moment.shown.filter(
      (item) => !moment.read.has(item.id),
    ).length;
    badge.hidden = !unread;
    set(badge, String(unread));
    layer.textContent = "";
    beads = beads.filter((bead) => {
      const progress = (now - bead.t0) / bead.d;
      if (progress >= 1) {
        if (bead.to) flashes[bead.to] = clockNow;
        return false;
      }
      if (progress < 0 || reduced) return true;
      const path = part<SVGPathElement>(bead.path);
      const point = path.getPointAtLength(path.getTotalLength() * progress);
      const color = `var(--${bead.who === "them" ? "them" : bead.who === "you" ? "you" : "agent"})`;
      dot(point.x, point.y, 8, color, "0.35", true);
      dot(point.x, point.y, 4, color, "1", false);
      return true;
    });
  }

  // ---- Terra view ---------------------------------------------------------------------------
  function buildLine(id: string, line: Line): LineDom {
    const row = element("div", "line");
    const body = element("div");
    body.style.minWidth = "0";
    const bubble = element("button", "bubble") as HTMLButtonElement;
    bubble.type = "button";
    const trip = element("div", "trip");
    trip.hidden = true;
    const ticks = element("div", "ticks");
    body.append(
      element(
        "div",
        `who ${line.source}`,
        t(`calls.${line.source === "you" ? "you" : "observatory.them"}`),
      ),
      bubble,
      trip,
    );
    row.append(body, ticks);
    bubble.onclick = () => {
      selectedLine = selectedLine === id ? null : id;
      wake();
    };
    return {
      row,
      said: element("div"),
      bubble,
      trip,
      ticks,
      text: "",
      key: "",
      tripKey: "",
    };
  }
  function drawTrip(dom: LineDom, id: string, line: Line, moment: Moment) {
    const final = line.revisions.find((r) => r.stage === "final");
    const read = firstRead.get(id);
    const cited = moment.done.find(
      (turn) =>
        turn.reason === "published" &&
        turn.payload?.sources?.includes(`t-${id}`),
    );
    const steps: [string, string, number | null | undefined][] = [
      ["ear", "firstWords", line.revisions[0].epoch_ms],
      ["lock", "locked", final?.epoch_ms],
      ["sparkles", "sentToTerra", read?.request_ms],
      ["quote", "cited", cited?.settle_ms],
    ];
    const key = steps.map(([, , ms]) => (ms && ms <= now ? ms : "")).join();
    if (key === dom.tripKey) return;
    dom.tripKey = key;
    dom.trip.textContent = "";
    for (const [name, word, ms] of steps) {
      const step = element("span");
      step.title = t(`calls.observatory.${word}`);
      step.append(icon(name), ms && ms <= now ? fine(ms - start) : "–");
      dom.trip.append(step);
    }
  }
  function drawTurns(dom: LineDom, id: string) {
    const mine = (byNewestLine.get(id) ?? []).filter((turn) =>
      before(turn.settle_ms, now),
    );
    const key = `${mine.map((turn) => turn.event_id + reasonOf(turn)).join()}|${selectedTurn ? turnKey(selectedTurn) : ""}`;
    if (key === dom.key) return;
    dom.key = key;
    dom.ticks.textContent = "";
    dom.said.textContent = "";
    for (const turn of mine) {
      const open = () => {
        selectedTurn = turn;
        deskKey = "";
        wake();
      };
      if (turn.reason === "published") {
        const said = element(
          "button",
          `said ${turn === selectedTurn ? "sel" : ""}`,
        ) as HTMLButtonElement;
        said.type = "button";
        said.onclick = open;
        const text = element("div");
        text.append(
          element("div", "tx", turn.payload?.text ?? ""),
          element("div", "tm", fine((turn.settle_ms as number) - start)),
        );
        said.append(
          icon(turn.kind === "answer" ? "message" : "sparkles"),
          text,
        );
        dom.said.append(said);
      } else {
        const tick = element(
          "button",
          `tick ${reasonOf(turn)} ${turn === selectedTurn ? "sel" : ""}`,
        ) as HTMLButtonElement;
        tick.type = "button";
        tick.title = `${turn.event_id}: ${label(turn)}`;
        tick.onclick = open;
        dom.ticks.append(tick);
      }
    }
  }
  function drawTerra(moment: Moment) {
    const keep = new Set(moment.shown.map((item) => item.id));
    for (const [id, dom] of lineDom)
      if (!keep.has(id)) {
        dom.row.remove();
        dom.said.remove();
        lineDom.delete(id);
      }
    const follow =
      playing &&
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
        120;
    let previous: LineDom | null = null;
    for (const { id, line, rev } of moment.shown) {
      let dom = lineDom.get(id);
      if (!dom) {
        dom = buildLine(id, line);
        lineDom.set(id, dom);
      }
      if (previous) {
        if (previous.said.nextSibling !== dom.row) previous.said.after(dom.row);
      } else if (transcript.firstChild !== dom.row) transcript.prepend(dom.row);
      if (dom.row.nextSibling !== dom.said) dom.row.after(dom.said);
      previous = dom;
      if (dom.text !== rev.text) dom.bubble.textContent = dom.text = rev.text;
      dom.bubble.classList.toggle("growing", rev.stage !== "final");
      dom.bubble.classList.toggle("sel", selectedLine === id);
      dom.row.classList.toggle("unread", !moment.read.has(id));
      dom.trip.hidden = selectedLine !== id;
      if (selectedLine === id) drawTrip(dom, id, line, moment);
      drawTurns(dom, id);
    }
    part("no-lines").hidden = moment.shown.length > 0;
    const mark = part("read");
    const anchor = moment.lastRead ? lineDom.get(moment.lastRead) : undefined;
    mark.hidden = !anchor;
    if (anchor && anchor.said.nextSibling !== mark) anchor.said.after(mark);
    if (follow) transcript.scrollTop = transcript.scrollHeight;
    drawDesk(moment);
  }
  function drawDesk(moment: Moment) {
    const turn =
      selectedTurn ?? moment.active ?? moment.done[moment.done.length - 1];
    const live = !selectedTurn && moment.active === turn;
    const state = selectedTurn
      ? t("calls.observatory.turnName", { id: selectedTurn.event_id })
      : t(
          `calls.observatory.phase.${!live && now >= end ? "ended" : phase(moment.active, now)}`,
        );
    set(part("d-word"), state);
    set(
      part("d-time"),
      turn
        ? live
          ? t("calls.observatory.secondsIn", {
              time: fine(now - (turn.request_ms ?? now)),
            })
          : t("calls.observatory.atTime", {
              time: fine((turn.request_ms ?? turn.event_ms) - start),
            })
        : "",
    );
    part("ring").classList.toggle("busy", live && !reduced);
    const key = `${turn ? turnKey(turn) : ""}|${before(turn?.settle_ms ?? null, now)}|${moment.done.length}|${!!selectedTurn}`;
    if (key === deskKey) return;
    deskKey = key;
    const why = part("d-why");
    why.textContent = "";
    const hold = part("d-hold");
    hold.textContent = "";
    part("d-empty").hidden = !!turn;
    part("d-details").hidden = !turn;
    drawTotals(moment);
    if (!turn) return;
    why.append(
      element(
        "span",
        "",
        turn.kind === "answer"
          ? t("calls.observatory.youAsked", { question: turn.question })
          : t(
              `calls.observatory.${turn.kind === "pointer" ? "pointerCheck" : "transcriptOnly"}`,
              {
                count: turn.lines_sent.length,
              },
            ),
      ),
    );
    for (const sent of turn.lines_sent.slice(-3))
      hold.append(element("div", "chip", sent.text));
    const tokens = turn.tokens;
    const bar = part("d-bar").children;
    const total = tokens ? tokens.inputTokens + tokens.outputTokens || 1 : 1;
    const widths = tokens
      ? [
          tokens.cachedInputTokens,
          tokens.inputTokens - tokens.cachedInputTokens,
          tokens.outputTokens,
        ]
      : [0, 0, 0];
    widths.forEach((width, index) => {
      (bar[index] as HTMLElement).style.width = `${(width / total) * 100}%`;
    });
    const legend = part("d-tok");
    legend.textContent = "";
    legend.append(
      ...(tokens
        ? [
            ["cached", tokens.cachedInputTokens],
            ["new", tokens.inputTokens - tokens.cachedInputTokens],
            ["out", tokens.outputTokens],
          ].map(([name, value]) =>
            element(
              "span",
              "",
              t(`calls.observatory.tokens.${name}`, {
                count: value.toLocaleString(),
              }),
            ),
          )
        : [element("span", "", t("calls.observatory.unknown"))]),
    );
    const verdict = part("d-verdict");
    verdict.textContent = "";
    if (before(turn.settle_ms, now)) {
      verdict.append(element("b", "", label(turn)));
      if (turn.why && turn.why !== "bridge" && turn.why !== turn.reason)
        verdict.append(" ", element("span", "calm", `(${turn.why})`));
    } else
      verdict.append(
        element("span", "calm", t("calls.observatory.notSettled")),
      );
    set(
      part("d-message"),
      turn.message ?? JSON.stringify(turn.lines_sent, null, 1),
    );
    set(part("d-raw"), turn.raw ?? "");
    part("d-raw-box").hidden = turn.raw === null;
  }
  function drawTotals(moment: Moment) {
    const history = part("d-hist");
    history.textContent = "";
    for (const turn of moment.done.slice(-40)) {
      const button = element("button", reasonOf(turn)) as HTMLButtonElement;
      button.type = "button";
      button.title = `${turn.event_id}: ${label(turn)}`;
      button.onclick = () => {
        selectedTurn = turn;
        deskKey = "";
        wake();
      };
      history.append(button);
    }
    set(part("m-turns"), String(moment.done.length));
    const tokens = moment.done.reduce(
      (sum, turn) => sum + (turn.tokens?.totalTokens ?? 0),
      0,
    );
    set(
      part("m-tokens"),
      tokens >= 1e6
        ? `${(tokens / 1e6).toFixed(1)}M`
        : `${(tokens / 1000).toFixed(1)}k`,
    );
    set(
      part("m-open"),
      String(
        turns.filter((turn) => !turn.complete && turn.event_ms <= now).length,
      ),
    );
  }

  // ---- Clock --------------------------------------------------------------------------------
  function draw() {
    set(part("t-now"), clock(now - start));
    if (!playing) scrub.value = String(((now - start) / (end - start)) * 1000);
    const moment = momentAt(prepared, now);
    if (view === "system") drawMap(moment);
    else if (view === "terra") drawTerra(moment);
  }
  function tick(ms: number) {
    frame = 0;
    if (playing) {
      if (live) now = end = finish();
      else now = Math.min(end, now + Math.min(100, ms - last) * speed);
      scrub.value = String(((now - start) / (end - start)) * 1000);
      if (!live && now >= end) setPlaying(false);
      spawn();
    }
    last = ms;
    draw();
    if (playing) {
      frame = requestAnimationFrame(tick);
    }
  }
  // Paused changes draw at once: a page that is not in front gets no animation frames.
  function wake() {
    if (!playing) {
      draw();
      return;
    }
    if (!frame) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }
  function setPlaying(next: boolean) {
    playing = next;
    part("icon-play-btn").hidden = next;
    part("icon-pause-btn").hidden = !next;
    wake();
  }

  scrub.oninput = () =>
    seek(start + ((end - start) * Number(scrub.value)) / 1000);
  part("play").onclick = () => {
    if (!playing && now >= end) seek(start);
    setPlaying(!playing);
  };
  part("speed").onclick = () => {
    speed = SPEEDS[speed];
    set(part("speed"), `${speed}x`);
  };
  for (const key of NODES)
    if (key !== "brief") nodes[key].onclick = onOpenTerra;
  set(part("t-end"), clock(end - start));
  set(part("speed"), "1x");
  part("icon-play-btn").hidden = live;
  part("icon-pause-btn").hidden = !live;
  wake();

  return {
    setView(next: string) {
      view = next;
      deskKey = "";
      wake();
    },
    /** New logs for the same call: keeps the clock, the selection and whatever is on screen. */
    update(next: ObservatoryData) {
      if (next === data) return;
      data = next;
      prepared = prepare(next);
      ({ lines, turns, byNewestLine, firstRead } = prepared);
      session = next.sessions[0];
      const atEnd = now >= end;
      end = finish();
      if (atEnd && !playing) now = end;
      const seen = events[events.length - 1]?.ms ?? 0;
      events = beadEvents();
      cursor = events.findIndex((event) => event.ms > (live ? seen : now));
      if (cursor < 0) cursor = events.length;
      selectedTurn =
        turns.find(
          (turn) => selectedTurn && turnKey(turn) === turnKey(selectedTurn),
        ) ?? null;
      deskKey = "";
      for (const dom of lineDom.values()) dom.key = "";
      set(part("t-end"), clock(end - start));
      draw();
    },
    /** The call ended: stop following the clock and rest at the end of what was heard. */
    setLive(next: boolean) {
      if (next === live) return;
      live = next;
      end = finish();
      now = end;
      set(part("t-end"), clock(end - start));
      setPlaying(false);
    },
    destroy() {
      cancelAnimationFrame(frame);
      frame = 0;
      playing = false;
    },
    // For the speed check: a median frame on this call, in ms.
    measure(count = 120) {
      const times: number[] = [];
      for (let i = 0; i < count; i++) {
        const at = performance.now();
        now = start + ((end - start) * i) / count;
        draw();
        times.push(performance.now() - at);
      }
      return times.sort((a, b) => a - b)[count >> 1];
    },
  };
}
