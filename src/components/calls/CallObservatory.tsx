import { useEffect, useRef, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioWaveform,
  Bell,
  Box,
  Captions,
  CircleAlert,
  Coins,
  Ear,
  Eraser,
  FileText,
  Gavel,
  History,
  Layers,
  Lock,
  MessageCircle,
  Mic,
  Pause,
  Phone,
  Play,
  Quote,
  Repeat,
  Sparkles,
} from "lucide-react";
import { createPlayer, type ObservatoryData } from "./observatoryPlayer";
import "./observatory.css";

const NODES: [string, number, number, ComponentType, string][] = [
  ["you", 150, 110, Mic, "you"],
  ["them", 150, 350, Phone, "them"],
  ["echo", 330, 110, Eraser, "you"],
  ["engine", 560, 230, AudioWaveform, ""],
  ["feed", 790, 230, Captions, ""],
  ["agent", 1010, 230, Sparkles, "agent"],
  ["notch", 1170, 110, Bell, ""],
  ["brief", 790, 410, Box, ""],
];
const COPIED_ICONS: [string, ComponentType][] = [
  ["ear", Ear],
  ["lock", Lock],
  ["sparkles", Sparkles],
  ["quote", Quote],
  ["message", MessageCircle],
];

export function CallObservatory({
  data,
  view,
  live,
  onOpenTerra,
}: {
  data: ObservatoryData;
  view: "system" | "terra";
  live: boolean;
  onOpenTerra: () => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const player = useRef<ReturnType<typeof createPlayer> | null>(null);
  const openTerra = useRef(onOpenTerra);
  openTerra.current = onOpenTerra;
  const latest = useRef({ data, live });
  latest.current = { data, live };

  useEffect(() => {
    if (!root.current) return;
    const created = createPlayer(
      root.current,
      latest.current.data,
      t,
      () => openTerra.current(),
      latest.current.live,
    );
    player.current = created;
    return () => {
      created.destroy();
      player.current = null;
    };
  }, [t]);
  useEffect(() => player.current?.setView(view), [view]);
  useEffect(() => player.current?.update(data), [data]);
  useEffect(() => player.current?.setLive(live), [live]);

  const session = data.sessions[0];
  // Open turns and a half-written last row are normal while a call runs. Anything else still shows.
  const problems = live
    ? data.problems.filter(
        (p) => !/never settled|cut short|never acknowledged/.test(p),
      )
    : data.problems;
  const turnCount = data.turns.length;
  return (
    <div className="obs-replay" ref={root}>
      <div hidden>
        {COPIED_ICONS.map(([name, Icon]) => (
          <span key={name} data-o={`icon-${name}`}>
            <Icon />
          </span>
        ))}
      </div>
      <div className="status">
        <span className={`dot ${problems.length ? "warn" : ""}`} />
        <span>
          {t("calls.observatory.summaryLine", {
            lines: Object.keys(data.lines).length,
            turns: turnCount,
          })}
        </span>
        {session && (
          <>
            <span className="sep">·</span>
            <span>{session.model}</span>
          </>
        )}
      </div>
      <div className="scrub">
        {live && (
          <span className="pill">
            <span className="rec" />
            {t("calls.observatory.live")}
          </span>
        )}
        <button
          className="icon-btn"
          hidden={live}
          data-o="play"
          aria-label={t("calls.observatory.playPause")}
          title={t("calls.observatory.playPause")}
        >
          <span data-o="icon-play-btn">
            <Play />
          </span>
          <span data-o="icon-pause-btn" hidden>
            <Pause />
          </span>
        </button>
        <button
          className="icon-btn mono"
          hidden={live}
          data-o="speed"
          title={t("calls.observatory.speed")}
        />
        <span className="mono" data-o="t-now" />
        <input
          type="range"
          hidden={live}
          data-o="scrub"
          min="0"
          max="1000"
          aria-label={t("calls.observatory.callTime")}
        />
        <span className="mono" hidden={live} data-o="t-end" />
      </div>

      <section hidden={view !== "system"}>
        <div className="map-scroll">
          <div className="map">
            <svg
              viewBox="0 0 1260 500"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <filter
                  id="obs-glow"
                  x="-200%"
                  y="-200%"
                  width="500%"
                  height="500%"
                >
                  <feGaussianBlur stdDeviation="4" result="b" />
                  <feMerge>
                    <feMergeNode in="b" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <path
                className="edge"
                data-o="p-mic-echo"
                d="M 150 110 L 330 110"
              />
              <path
                className="edge"
                data-o="p-echo-engine"
                d="M 330 110 C 430 110, 440 230, 560 230"
              />
              <path
                className="edge"
                data-o="p-them-engine"
                d="M 150 350 C 380 350, 420 230, 560 230"
              />
              <path
                className="edge"
                data-o="p-engine-feed"
                d="M 560 230 L 790 230"
              />
              <path
                className="edge"
                data-o="p-feed-agent"
                d="M 790 230 L 1010 230"
              />
              <path
                className="edge"
                data-o="p-agent-notch"
                d="M 1010 230 C 1120 230, 1150 230, 1170 110"
              />
              <path
                className="edge dash"
                d="M 790 410 C 900 410, 1010 380, 1010 230"
              />
              <g data-o="beads" />
            </svg>
            {NODES.map(([key, x, y, Icon, kind]) => (
              <button
                key={key}
                className={`node ${kind}`}
                data-o={`node-${key}`}
                title={t(`calls.observatory.nodeTip.${key}`)}
                style={{
                  left: `${(x / 1260) * 100}%`,
                  top: `${(y / 500) * 100}%`,
                }}
              >
                <span className="ic">
                  <Icon />
                </span>
                <span>
                  <span className="nm">
                    {t(`calls.observatory.node.${key}`)}
                  </span>
                  <br />
                  <span className="st" data-o={`stat-${key}`} />
                </span>
                {key === "feed" && (
                  <span className="badge" data-o="badge" hidden />
                )}
              </button>
            ))}
            <div className="key">
              <span>
                <i style={{ background: "var(--you)" }} />
                {t("calls.you")}
              </span>
              <span>
                <i style={{ background: "var(--them)" }} />
                {t("calls.observatory.them")}
              </span>
              <span>
                <i style={{ background: "var(--agent)" }} />
                {t("calls.observatory.terra")}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section hidden={view !== "terra"}>
        <div className="split">
          <div className="panel">
            <div className="transcript" data-o="transcript">
              <div className="calm" data-o="no-lines">
                {t("calls.observatory.noLines")}
              </div>
              <div className="read" data-o="read" hidden>
                {t("calls.observatory.read")}
              </div>
            </div>
          </div>
          <div className="panel desk">
            <div className="now">
              <div className="ring" data-o="ring">
                <Sparkles />
              </div>
              <div>
                <div className="word" data-o="d-word" />
                <div className="tm" data-o="d-time" />
              </div>
            </div>
            <div className="calm" data-o="d-empty">
              {t("calls.observatory.noTurn")}
            </div>
            <div className="desk" data-o="d-details" hidden>
              <div className="row" title={t("calls.observatory.whyWoke")}>
                <Bell />
                <div className="body" data-o="d-why" />
              </div>
              <div className="row" title={t("calls.observatory.linesSent")}>
                <Layers />
                <div className="body" data-o="d-hold" />
              </div>
              <div className="row" title={t("calls.observatory.turnTokens")}>
                <Coins />
                <div className="body">
                  <div className="bar" data-o="d-bar">
                    <span className="c" />
                    <span className="n" />
                    <span className="o" />
                  </div>
                  <div className="legend" data-o="d-tok" />
                </div>
              </div>
              <div className="row" title={t("calls.observatory.verdictTip")}>
                <Gavel />
                <div className="body verdict" data-o="d-verdict" />
              </div>
              <div className="row" title={t("calls.observatory.exact")}>
                <FileText />
                <div className="body">
                  <details>
                    <summary>{t("calls.observatory.exactMessage")}</summary>
                    <pre data-o="d-message" />
                  </details>
                  <details data-o="d-raw-box">
                    <summary>{t("calls.observatory.rawReply")}</summary>
                    <pre data-o="d-raw" />
                  </details>
                </div>
              </div>
            </div>
            <div className="row" title={t("calls.observatory.turnsSoFar")}>
              <History />
              <div className="body">
                <div className="hist" data-o="d-hist" />
              </div>
            </div>
            <div className="meter">
              <div title={t("calls.observatory.turnsSettled")}>
                <Repeat />
                <b data-o="m-turns">0</b>
              </div>
              <div title={t("calls.observatory.tokensKnown")}>
                <Coins />
                <b data-o="m-tokens">0</b>
              </div>
              <div title={t("calls.observatory.neverSettled")}>
                <CircleAlert />
                <b data-o="m-open">0</b>
              </div>
            </div>
          </div>
        </div>
      </section>
      {problems.length > 0 && (
        <details>
          <summary>
            {t("calls.observatory.problems", { count: problems.length })}
          </summary>
          <pre>{problems.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
