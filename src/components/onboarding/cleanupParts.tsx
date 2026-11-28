// The cleanup chooser and its live test, shared by the onboarding Cleanup
// step and Settings > Cleanup. One hook holds the state; the two components
// draw the option list and the test pane with the mockups' markup, and each
// page's CSS (onboarding.css, cleanup-settings.css) styles them.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ArrowDown,
  Check,
  CircleAlert,
  LoaderCircle,
  RotateCw,
} from "lucide-react";
import { Dropdown } from "../ui/Dropdown";
import {
  api,
  type CleanupChoice,
  type CleanupTestError,
  defaultCloudModel,
  type CloudProvider,
  type LocalServer,
  type S1Status,
} from "./api";
import { I, mb } from "./Frame";

export type Opt = "s1" | "local" | "cloud" | "apple" | "off";
export type Test =
  | { status: "testing" }
  | { status: "passed"; ms: number; output: string; id: number }
  | { status: "failed"; error: CleanupTestError };

const DETECT_TIMEOUT_MS = 1000;
const SLOW_MS = 1500;
const KEY_DEBOUNCE_MS = 700;
const MIN_KEY_LENGTH = 8;

/** Out of focus a key shows only its start and end: sk-proj-••••3fA9. */
const maskKey = (k: string) =>
  k.length > 12
    ? `${k.slice(0, 8)}${"•".repeat(16)}${k.slice(-4)}`
    : "•".repeat(k.length);

// Small, fast chat models suit cleanup; avoid embeddings, audio and images.
const SKIP =
  /embed|whisper|tts|audio|image|dall|vision|moderation|realtime|transcribe|search/i;
const SMALL = /mini|haiku|flash|small|lite|instant|air|8b|nano/i;

/** The preferred model if listed, else a small chat model, else the first. */
export function pickModel(list: string[], preferred: string) {
  if (preferred && list.includes(preferred)) return preferred;
  const chat = list.filter((m) => !SKIP.test(m));
  return chat.find((m) => SMALL.test(m)) ?? chat[0] ?? list[0];
}

const NUMBERS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};
const norm = (w: string) => {
  const n = w.toLowerCase().replace(/[^a-z0-9']/g, "");
  return NUMBERS[n] ?? n;
};

/** The sample split into runs, each marked dropped when the cleaned output
 *  no longer has those words (a longest common subsequence of words), so the
 *  pane greys only what was actually removed. */
export function droppedRuns(sample: string, output: string) {
  const a = sample.split(/\s+/).filter(Boolean);
  const b = output.split(/\s+/).map(norm).filter(Boolean);
  const an = a.map(norm);
  const L = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i][j] =
        an[i] === b[j]
          ? L[i + 1][j + 1] + 1
          : Math.max(L[i + 1][j], L[i][j + 1]);
  const kept: boolean[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length) {
    if (j < b.length && an[i] === b[j]) {
      kept.push(true);
      i++;
      j++;
    } else if (j < b.length && L[i][j + 1] > L[i + 1][j]) j++;
    else {
      kept.push(false);
      i++;
    }
  }
  const runs: { text: string; dropped: boolean }[] = [];
  a.forEach((w, k) => {
    const last = runs[runs.length - 1];
    if (last && last.dropped === !kept[k]) last.text += ` ${w}`;
    else runs.push({ text: w, dropped: !kept[k] });
  });
  return runs;
}

interface ChooserOptions {
  /** The option picked when the page opens. */
  initial?: Opt;
  /** A local server already configured (Settings), shown even when it is
   *  not answering right now. */
  configuredServer?: LocalServer | null;
  initialProvider?: string;
  /** A key already saved for a provider (Settings): tests use it and no key
   *  field is asked for. Never shown. */
  savedKey?: (providerId: string) => string;
  /** Tests run only while this is true (Settings: cleanup is on). */
  active?: boolean;
  /** Told when the user picks Voce cleanup (true) or turns it down. */
  onS1Choice?: (wanted: boolean) => void;
}

export function useCleanupChooser({
  initial = "s1",
  configuredServer = null,
  initialProvider = "",
  savedKey,
  active = true,
  onS1Choice,
}: ChooserOptions = {}) {
  const [opt, setOpt] = useState<Opt>(initial);
  const [s1, setS1] = useState<S1Status | null>(null);
  const [s1Failed, setS1Failed] = useState(false);
  const s1Started = useRef(false);
  const [server, setServer] = useState<LocalServer | null>(configuredServer);
  const [localModel, setLocalModel] = useState(
    configuredServer?.models[0] ?? "",
  );
  const [providers, setProviders] = useState<CloudProvider[]>([]);
  const [provider, setProvider] = useState(initialProvider);
  // Keys typed in this session, per provider: a key only ever goes to the
  // provider it was typed for.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = drafts[provider] ?? "";
  // Each cloud provider's real model list, fetched with the key, and the
  // model picked from it. A failed listing leaves the built-in default.
  const [modelLists, setModelLists] = useState<
    Record<string, string[] | "loading">
  >({});
  const [modelPick, setModelPick] = useState<Record<string, string>>({});
  // The key each provider's list was fetched with: a test waits until the
  // list for the current key is in, so it runs once, on a real model.
  const [listedWith, setListedWith] = useState<Record<string, string>>({});
  // Counts the user's own changes; Settings saves only after one.
  const [touched, setTouched] = useState(0);
  const touch = () => setTouched((n) => n + 1);
  const [test, setTest] = useState<Test | null>(null);
  // A Voce cleanup test that runs past this is starting the server (its
  // first start on a Mac takes seconds); the pane says so instead.
  const [starting, setStarting] = useState(false);
  // Each test has an id; a result for an older id is ignored (row 16b).
  const reqId = useRef(0);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    api
      .getS1Status()
      .then((s) => alive && setS1(s))
      .catch((e) => console.warn("s1 status:", e));
    api
      .onS1Status((s) => alive && setS1(s))
      .then((off) => (alive ? (unlisten = off) : off()));
    // Detection never holds up the screen (row 13).
    Promise.race([
      api.detectLocalServers(),
      new Promise<LocalServer[]>((r) =>
        setTimeout(() => r([]), DETECT_TIMEOUT_MS),
      ),
    ])
      .then((found) => {
        if (!alive || !found[0]) return;
        const same =
          configuredServer &&
          found.find((s) => s.baseUrl === configuredServer.baseUrl);
        const pick = same || found[0];
        setServer((prev) =>
          prev && same
            ? {
                ...pick,
                models: [...new Set([...prev.models, ...pick.models])],
              }
            : (prev ?? pick),
        );
        setLocalModel((m) => m || pick.models[0] || "");
      })
      .catch((e) => console.warn("Local server detection:", e));
    api
      .cloudProviders()
      .then((list) => {
        if (!alive) return;
        setProviders(list);
        setProvider((p) => p || list[0]?.id || "");
      })
      .catch((e) => console.warn("Cloud providers:", e));
    return () => {
      alive = false;
      unlisten?.();
      reqId.current++; // leaving drops any test in flight
      api.forgetCleanupTests().catch(() => {});
    };
    // Mount only: the configured server is the one the page opened with.
  }, []);

  const startS1 = useCallback(async () => {
    s1Started.current = true;
    setS1Failed(false);
    try {
      await api.downloadS1();
    } catch (e) {
      console.warn("s1-mini download:", e);
      setS1Failed(true);
    }
  }, []);

  const s1Down = s1Failed || s1?.state === "failed";
  const s1Busy = !s1Down && s1?.state === "downloading";

  // With Voce cleanup picked and on disk, start its server now so the test
  // and the first dictation do not wait for it.
  useEffect(() => {
    if (active && opt === "s1" && s1?.state === "ready")
      api.warmS1().catch((e) => console.warn("Warming Voce cleanup:", e));
  }, [active, opt, s1?.state]);

  // Picking Voce cleanup starts its download (onboarding: the default pick).
  useEffect(() => {
    if (opt === "s1" && s1?.state === "missing" && !s1Started.current)
      startS1();
  }, [opt, s1?.state, startS1]);

  /** The user's pick, else the saved model if listed (or not listable),
   *  else a small model from the real list, else the built-in default. */
  const cloudModel = useCallback(
    (id: string) => {
      const fallback =
        providers.find((p) => p.id === id)?.model || defaultCloudModel(id);
      const list = modelLists[id];
      if (modelPick[id]) return modelPick[id];
      return Array.isArray(list) && list.length
        ? pickModel(list, fallback)
        : fallback;
    },
    [providers, modelLists, modelPick],
  );

  const choice = useCallback((): CleanupChoice | null => {
    if (opt === "s1") return { kind: "s1" };
    if (opt === "apple") return { kind: "apple" };
    if (opt === "off") return { kind: "off" };
    if (opt === "local")
      return server && localModel
        ? {
            kind: "local",
            server: server.kind,
            baseUrl: server.baseUrl,
            model: localModel,
          }
        : null;
    const p = providers.find((x) => x.id === provider);
    const k = p ? (drafts[p.id] ?? "").trim() || savedKey?.(p.id) || "" : "";
    const model = p ? cloudModel(p.id) : "";
    return p && model && k.length >= MIN_KEY_LENGTH
      ? { kind: "cloud", provider: p.id, model, apiKey: k }
      : null;
  }, [
    opt,
    server,
    localModel,
    providers,
    provider,
    drafts,
    savedKey,
    cloudModel,
  ]);

  // With a key, list the provider's models and preselect one (review 4).
  const cloudKey =
    opt === "cloud"
      ? (drafts[provider] ?? "").trim() || savedKey?.(provider) || ""
      : "";
  useEffect(() => {
    if (!provider || cloudKey.length < MIN_KEY_LENGTH) return;
    let alive = true;
    setModelLists((m) => ({ ...m, [provider]: "loading" }));
    const id = setTimeout(() => {
      api
        .listCloudModels(provider, cloudKey)
        .catch((e) => {
          console.warn("Listing models:", e);
          return [] as string[];
        })
        .then((list) => {
          if (!alive) return;
          setModelLists((m) => ({ ...m, [provider]: list }));
          setListedWith((m) => ({ ...m, [provider]: cloudKey }));
        });
    }, KEY_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [provider, cloudKey]);

  const run = useCallback(async (c: CleanupChoice) => {
    const id = ++reqId.current;
    setTest({ status: "testing" });
    setStarting(false);
    const slow =
      c.kind === "s1"
        ? setTimeout(() => id === reqId.current && setStarting(true), SLOW_MS)
        : undefined;
    let r;
    try {
      r = await api.testCleanup(c, id);
    } catch (e) {
      console.warn("Cleanup test:", e);
      r = { ok: false as const, error: "unknown" as const };
    }
    clearTimeout(slow);
    if (id !== reqId.current) return;
    setStarting(false);
    if (!r.ok && r.error === "download_needed") {
      // The model went missing since the status check: download it again.
      s1Started.current = false;
      setS1((s) => (s ? { ...s, state: "missing" } : s));
      setTest(null);
      return;
    }
    setTest(
      r.ok
        ? { status: "passed", ms: r.ms, output: r.output, id }
        : { status: "failed", error: r.error },
    );
  }, []);

  // Start a test whenever the current option is ready and has none.
  useEffect(() => {
    if (!active || test || opt === "off") return;
    if (opt === "s1" && s1?.state !== "ready") return;
    // A cloud test waits for the model list, so it runs once, on a real model.
    if (opt === "cloud" && listedWith[provider] !== cloudKey) return;
    const c = choice();
    if (!c) return;
    // A typed key is already debounced by the model listing above.
    run(c);
  }, [
    active,
    test,
    opt,
    s1?.state,
    choice,
    run,
    listedWith,
    cloudKey,
    provider,
  ]);

  /** Drop the current test (a late result is ignored) and test again. */
  const reset = useCallback(() => {
    reqId.current++;
    setTest(null);
  }, []);
  /** The user turned Voce cleanup down: stop its download (the partial
   *  file stays; picking it again resumes). */
  const stopS1 = useCallback(() => {
    s1Started.current = false;
    onS1Choice?.(false);
    // Also stops a warm-up of the server when the model is already here.
    api.cancelS1().catch((e) => console.warn("Stopping s1-mini:", e));
  }, [onS1Choice]);
  const select = (o: Opt) => {
    if (o === opt) return;
    reset();
    touch();
    if (o !== "s1") stopS1();
    else onS1Choice?.(true);
    setOpt(o);
  };

  return {
    opt,
    select,
    s1,
    s1Down,
    s1Busy,
    startS1,
    server,
    localModel,
    setLocalModel: (m: string) => {
      reset();
      touch();
      setLocalModel(m);
    },
    /** A new endpoint for the local server; its old test no longer counts.
     *  With none detected or configured it becomes a custom server. */
    setServerBaseUrl: (baseUrl: string) => {
      reset();
      touch();
      setServer((s) =>
        s ? { ...s, baseUrl } : { kind: "custom", baseUrl, models: [] },
      );
    },
    providers,
    provider,
    setProvider: (p: string) => {
      reset();
      touch();
      setProvider(p);
    },
    modelList: (id: string) => {
      const l = modelLists[id];
      return Array.isArray(l) ? l : [];
    },
    cloudModel,
    pickCloudModel: (id: string, model: string) => {
      reset();
      touch();
      setModelPick((m) => ({ ...m, [id]: model }));
    },
    key,
    setKey: (k: string) => {
      reset();
      touch();
      setDrafts((d) => ({ ...d, [provider]: k }));
    },
    touched,
    touch,
    hasSavedKey: (id: string) => !!savedKey?.(id),
    test,
    starting,
    stopS1,
    reset,
    choice,
  };
}

export type Chooser = ReturnType<typeof useCleanupChooser>;

/** The display name used in test messages. */
export function useChoiceName(c: Chooser) {
  const { t } = useTranslation();
  const serverName = c.server
    ? t(`onboarding.cleanup.servers.${c.server.kind}`)
    : "";
  const providerName =
    c.providers.find((p) => p.id === c.provider)?.label ?? "";
  const name =
    c.opt === "s1"
      ? t("onboarding.cleanup.s1.name")
      : c.opt === "apple"
        ? t("onboarding.cleanup.apple.name")
        : c.opt === "local"
          ? serverName
          : providerName;
  return { name, serverName };
}

const Err: React.FC<{
  title: string;
  body: string;
  children: React.ReactNode;
}> = ({ title, body, children }) => (
  <div className="err" role="alert">
    <I icon={CircleAlert} s={18} className="ic" />
    <div>
      <h3>{title}</h3>
      <p>{body}</p>
      <div className="btns">{children}</div>
    </div>
  </div>
);

/** The option rows. `compact`: Settings' shorter descriptions. */
export const CleanupOptions: React.FC<{
  c: Chooser;
  compact?: boolean;
  showOff?: boolean;
  /** Settings, when this Mac supports Apple Intelligence. */
  showApple?: boolean;
  /** Settings: a custom server is always offered, set under Advanced,
   *  even when none was detected. */
  showCustom?: boolean;
}> = ({
  c,
  compact = false,
  showOff = true,
  showApple = false,
  showCustom = false,
}) => {
  const { t } = useTranslation();
  const { serverName } = useChoiceName(c);
  const [keyFocused, setKeyFocused] = useState(false);
  const { s1 } = c;
  const progress = s1 && s1.total > 0 ? (100 * s1.downloaded) / s1.total : 0;
  const keyRejected =
    c.opt === "cloud" &&
    c.test?.status === "failed" &&
    c.test.error === "key_rejected";

  const row = (o: Opt, children: React.ReactNode) => (
    <div
      className={`opt ${c.opt === o ? "sel" : ""}`}
      role="radio"
      aria-checked={c.opt === o}
      tabIndex={0}
      onClick={() => c.select(o)}
      onKeyDown={(e) => {
        if (
          e.target === e.currentTarget &&
          (e.key === " " || e.key === "Enter")
        )
          c.select(o);
      }}
    >
      <span className="radio" />
      <div className="body">{children}</div>
    </div>
  );

  return (
    <div className="v-group opts" role="radiogroup">
      {row(
        "s1",
        <>
          <div className="name">
            {t("onboarding.cleanup.s1.name")}{" "}
            <span className="faint" style={{ fontWeight: 500 }}>
              {t("onboarding.cleanup.s1.model")}
            </span>{" "}
            <span className="badge">{t("onboarding.recommended")}</span>
          </div>
          <div className="desc">
            {compact
              ? t("onboarding.cleanup.s1.short")
              : t("onboarding.cleanup.s1.description", {
                  mb: s1 ? mb(s1.total) : 480,
                })}
          </div>
          {c.s1Busy && s1 && (
            <div className="prog">
              <div className="bar">
                <b style={{ width: `${progress}%` }} />
              </div>
              <div className="line">
                {t("onboarding.ofMb", {
                  done: mb(s1.downloaded),
                  total: mb(s1.total),
                })}
                {s1.secondsLeft
                  ? ` · ${t("onboarding.etaSeconds", { count: Math.round(s1.secondsLeft) })}`
                  : ""}
              </div>
            </div>
          )}
          {c.s1Down && s1 && s1.downloaded > 0 && (
            <div className="prog">
              <div className="bar">
                <b
                  style={{
                    width: `${progress}%`,
                    background: "var(--danger)",
                  }}
                />
              </div>
              <div className="line">
                {t("onboarding.cleanup.stopped", {
                  done: mb(s1.downloaded),
                  total: mb(s1.total),
                })}
              </div>
            </div>
          )}
        </>,
      )}
      {(c.server || showCustom) &&
        row(
          "local",
          <>
            <div className="name">
              {c.server ? serverName : t("onboarding.cleanup.servers.custom")}
              {c.server && c.server.kind !== "custom" && (
                <>
                  {" "}
                  <span className="badge found">
                    {t("onboarding.cleanup.found")}
                  </span>
                </>
              )}
            </div>
            <div className="desc">
              {!c.server || c.server.kind === "custom"
                ? t("onboarding.cleanup.custom.short")
                : t(
                    compact
                      ? "onboarding.cleanup.local.short"
                      : "onboarding.cleanup.local.description",
                    { name: serverName },
                  )}
            </div>
            {/* Settings sets the model under Advanced. */}
            {!compact && c.opt === "local" && !!c.server?.models.length && (
              <div className="fields" onClick={(e) => e.stopPropagation()}>
                <Dropdown
                  className="w-full"
                  options={c.server.models.map((m) => ({
                    value: m,
                    label: m,
                  }))}
                  selectedValue={c.localModel}
                  onSelect={c.setLocalModel}
                />
              </div>
            )}
          </>,
        )}
      {row(
        "cloud",
        <>
          <div className="name">{t("onboarding.cleanup.cloud.name")}</div>
          <div className="desc">
            {compact
              ? t("onboarding.cleanup.cloud.short")
              : t("onboarding.cleanup.cloud.description")}
          </div>
          {c.opt === "cloud" && (
            <div className="fields" onClick={(e) => e.stopPropagation()}>
              <Dropdown
                className="w-full"
                options={c.providers.map((p) => ({
                  value: p.id,
                  label: p.label,
                }))}
                selectedValue={c.provider}
                onSelect={c.setProvider}
              />
              {c.modelList(c.provider).length > 0 && (
                <Dropdown
                  className="w-full"
                  options={c.modelList(c.provider).map((m) => ({
                    value: m,
                    label: m,
                  }))}
                  selectedValue={c.cloudModel(c.provider)}
                  onSelect={(m) => c.pickCloudModel(c.provider, m)}
                />
              )}
              {!c.hasSavedKey(c.provider) && (
                <input
                  type="text"
                  className={`v-field mono ${keyRejected ? "bad" : ""}`}
                  placeholder={t("onboarding.cleanup.cloud.keyPlaceholder")}
                  aria-label={t("onboarding.cleanup.cloud.keyLabel")}
                  autoComplete="off"
                  spellCheck={false}
                  value={keyFocused ? c.key : maskKey(c.key)}
                  onFocus={() => setKeyFocused(true)}
                  onBlur={() => setKeyFocused(false)}
                  onChange={(e) => c.setKey(e.target.value)}
                />
              )}
            </div>
          )}
        </>,
      )}
      {showApple &&
        row(
          "apple",
          <>
            <div className="name">{t("onboarding.cleanup.apple.name")}</div>
            <div className="desc">
              {t("onboarding.cleanup.apple.description")}
            </div>
          </>,
        )}
      {showOff &&
        row(
          "off",
          <>
            <div className="name">{t("onboarding.cleanup.off.name")}</div>
            <div className="desc">
              {t("onboarding.cleanup.off.description")}
            </div>
          </>,
        )}
    </div>
  );
};

/** The live test pane: status, the sample, and what Voce would paste. */
export const LiveTest: React.FC<{
  c: Chooser;
  /** Settings: a Run again button beside a finished result. */
  canRerun?: boolean;
  arrowSize?: number;
  /** Onboarding: offer Off when Voce cleanup cannot start. */
  onTurnOff?: () => void;
  /** Settings with cleanup off: no test runs; Voce pastes the raw text. */
  off?: boolean;
}> = ({ c, canRerun = false, arrowSize = 16, onTurnOff, off = false }) => {
  const { t } = useTranslation();
  const { name, serverName } = useChoiceName(c);
  const { opt, test, s1 } = c;
  // Before a result, the sample marks the usual fillers; after one, only
  // the words this model actually dropped (test app bug 5).
  const said =
    test?.status === "passed" && opt !== "off" && !off ? (
      droppedRuns(
        t("onboarding.cleanup.sample").replace(/<\/?s>/g, ""),
        test.output,
      ).map((r, k) => (
        <React.Fragment key={k}>
          {k > 0 && " "}
          {r.dropped ? <s>{r.text}</s> : r.text}
        </React.Fragment>
      ))
    ) : (
      <Trans i18nKey="onboarding.cleanup.sample" components={{ s: <s /> }} />
    );
  const rerun = canRerun && (
    <button
      type="button"
      className="v-ib"
      title={t("onboarding.cleanup.test.runAgain")}
      aria-label={t("onboarding.cleanup.test.runAgain")}
      onClick={c.reset}
    >
      <I icon={RotateCw} s={14} />
    </button>
  );

  let status: React.ReactNode;
  let result: React.ReactNode;
  if (opt === "off" || off) {
    status = <span className="st">{t("onboarding.cleanup.test.off")}</span>;
    result = <div className="out raw">{said}</div>;
  } else if (opt === "s1" && c.s1Down) {
    status = (
      <span className="st fail">{t("onboarding.cleanup.test.failed")}</span>
    );
    result = (
      <Err
        title={t("onboarding.cleanup.errors.download.title")}
        body={t("onboarding.cleanup.errors.download.body")}
      >
        <button type="button" className="v-btn v-secondary" onClick={c.startS1}>
          <I icon={RotateCw} />
          {t("onboarding.cleanup.retryDownload")}
        </button>
      </Err>
    );
  } else if (opt === "s1" && s1?.state !== "ready") {
    status = (
      <span className="st">{t("onboarding.cleanup.test.afterDownload")}</span>
    );
    result = (
      <div className="waitline">{t("onboarding.cleanup.test.runsItself")}</div>
    );
  } else if (opt === "local" && !c.choice()) {
    status = (
      <span className="st">{t("onboarding.cleanup.test.waitingServer")}</span>
    );
    result = (
      <div className="waitline">{t("onboarding.cleanup.test.setServer")}</div>
    );
  } else if (opt === "cloud" && !c.choice()) {
    status = (
      <span className="st">{t("onboarding.cleanup.test.waitingKey")}</span>
    );
    result = (
      <div className="waitline">{t("onboarding.cleanup.test.pasteKey")}</div>
    );
  } else if (!test || test.status === "testing") {
    status = (
      <span className="st">
        <I icon={LoaderCircle} className="spin" />
        {opt === "s1"
          ? c.starting
            ? t("onboarding.cleanup.test.startingHere")
            : t("onboarding.cleanup.test.testingHere")
          : t("onboarding.cleanup.test.testingWith", { name })}
      </span>
    );
    result = (
      <div className="shimmer">
        <i />
        <i />
      </div>
    );
  } else if (test.status === "passed") {
    status = (
      <span className="st pass">
        <I icon={Check} />
        <span>
          {t("onboarding.cleanup.test.passed", {
            // Never "0.0 s": a fast local answer still reads as a time.
            s: Math.max(0.1, test.ms / 1000).toFixed(1),
          })}
        </span>
        {rerun}
      </span>
    );
    result = <div className="out">{test.output}</div>;
  } else {
    status = (
      <span className="st fail">{t("onboarding.cleanup.test.failed")}</span>
    );
    const e = test.error;
    const where =
      opt === "cloud" && e === "unreachable" ? "cloudUnreachable" : e;
    result = (
      <Err
        title={t(`onboarding.cleanup.errors.${where}.title`, { name })}
        body={t(`onboarding.cleanup.errors.${where}.body`, { name })}
      >
        <button type="button" className="v-btn v-secondary" onClick={c.reset}>
          <I icon={RotateCw} />
          {t("onboarding.retry")}
        </button>
        {opt === "local" &&
          e === "unreachable" &&
          c.server &&
          c.server.kind !== "custom" && (
            <button
              type="button"
              className="v-btn v-ghost"
              onClick={() =>
                api
                  .openLocalServerApp(c.server!.kind)
                  .catch((err) => console.warn("Open local server:", err))
              }
            >
              {t("onboarding.cleanup.openServer", { name: serverName })}
            </button>
          )}
        {opt === "s1" && e === "start_failed" && c.server && (
          <button
            type="button"
            className="v-btn v-ghost"
            onClick={() => c.select("local")}
          >
            {t("onboarding.cleanup.useServer", { name: serverName })}
          </button>
        )}
        {opt === "s1" && e === "start_failed" && onTurnOff && (
          <button type="button" className="v-btn v-ghost" onClick={onTurnOff}>
            {t("onboarding.cleanup.turnOff")}
          </button>
        )}
      </Err>
    );
  }

  return (
    <div className="v-group test" aria-live="polite">
      <div className="top">
        <h2>{t("onboarding.cleanup.test.title")}</h2>
        {status}
      </div>
      <div className="sec">
        <div className="k">{t("onboarding.cleanup.test.youSay")}</div>
        <div className="said">{said}</div>
      </div>
      <div className="arrow">
        <I icon={ArrowDown} s={arrowSize} />
      </div>
      <div className="sec">
        <div className="k">{t("onboarding.cleanup.test.vocePastes")}</div>
        {result}
      </div>
    </div>
  );
};
