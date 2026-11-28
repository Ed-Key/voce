import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronDown, Eye, Lock } from "lucide-react";
import { commands, type AppSettings } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { Switch } from "../../ui/ToggleSwitch";
import { PageHeader } from "../../ui/PageHeader";
import { ShortcutInput } from "../ShortcutInput";
import {
  api,
  type CleanupChoice,
  type AppleState,
  type LocalServer,
  type S1Control,
} from "@/components/onboarding/api";
import { I } from "@/components/onboarding/Frame";
import {
  CleanupOptions,
  LiveTest,
  useCleanupChooser,
  type Chooser,
  type Opt,
} from "@/components/onboarding/cleanupParts";
import "./cleanup-settings.css";

// Fields the backend added that bindings.ts does not list yet.
type Settings = AppSettings & {
  early_cleanup?: boolean;
  s1_styling?: S1Control["styling"];
  s1_structure?: S1Control["structure"];
  s1_context?: S1Control["context"];
};

const VOCE_LOCAL = "voce_local";
const APPLE_RECHECK_MS = 3000;
const DEFAULT_PROMPT_ID = "default_improve_transcriptions";
const STYLES: S1Control["styling"][] = [
  "casual",
  "semi-casual",
  "semi-formal",
  "formal",
];
const STRUCTURES: S1Control["structure"][] = ["prose", "lists"];
const CONTEXTS: S1Control["context"][] = ["general", "email"];

/** Elements under a dimmed block are also inert (no focus, no clicks). */
const inert = (on: boolean) =>
  (on ? { inert: "" } : {}) as React.HTMLAttributes<HTMLElement>;

const providerOf = (c: Chooser) =>
  c.opt === "s1"
    ? VOCE_LOCAL
    : c.opt === "apple"
      ? "apple_intelligence"
      : c.opt === "local"
        ? "custom"
        : c.provider;

/** Settings > Cleanup: the switch, the model and live test, s1-mini's
 *  style, both dictation shortcuts and the advanced provider fields. */
export const CleanupSettings: React.FC = () => {
  const { settings, refreshSettings } = useSettings();
  // The store may hold settings from before onboarding or another window
  // changed cleanup; the page reads them fresh, so it shows what dictation
  // will actually do (test app bug 1).
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    refreshSettings().finally(() => setFresh(true));
  }, [refreshSettings]);
  if (!settings || !fresh) return null;
  return <CleanupPage settings={settings as Settings} />;
};

const CleanupPage: React.FC<{ settings: Settings }> = ({ settings }) => {
  const { t } = useTranslation();
  const { refreshSettings, updatePostProcessBaseUrl, updatePostProcessApiKey } =
    useSettings();

  const enabled = settings.post_process_enabled ?? false;
  const [wantOn, setWantOn] = useState(enabled);
  const savedProvider = settings.post_process_provider_id ?? VOCE_LOCAL;
  const custom = settings.post_process_providers?.find(
    (p) => p.id === "custom",
  );
  const keys = settings.post_process_api_keys ?? {};

  // The chooser opens on the saved choice.
  const [opening] = useState(() => {
    // Apple Intelligence stays its own choice; it is never swapped for
    // Voce cleanup behind the user's back.
    const initial: Opt =
      savedProvider === "apple_intelligence"
        ? "apple"
        : savedProvider === VOCE_LOCAL
          ? "s1"
          : savedProvider === "custom"
            ? "local"
            : "cloud";
    const configuredServer: LocalServer | null =
      savedProvider === "custom" && custom?.base_url
        ? {
            kind: custom.base_url.includes(":11434")
              ? "ollama"
              : custom.base_url.includes(":1234")
                ? "lm_studio"
                : "custom",
            baseUrl: custom.base_url,
            models: [settings.post_process_models?.custom ?? ""].filter(
              Boolean,
            ),
          }
        : null;
    return {
      initial,
      configuredServer,
      initialProvider: initial === "cloud" ? savedProvider : "",
    };
  });
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const savedKey = useMemo(() => (id: string) => keysRef.current[id] ?? "", []);
  // Apple Intelligence is offered on every Mac that can run it; until it
  // is ready (turned off, model downloading) the row says what is missing,
  // its test waits, and readiness is checked again while the page is open.
  // Nothing runs while the window is hidden (closing it only hides it):
  // no readiness checks, no new tests, no saves; showing it checks again.
  const visible = useWindowVisible();
  const [appleState, setAppleState] = useState<AppleState | null>(null);
  const appleSettled = appleState === "ready" || appleState === "unsupported";
  useEffect(() => {
    if (appleSettled || !visible) return;
    let alive = true;
    const check = () =>
      api
        .appleState()
        .then((s) => alive && setAppleState(s))
        .catch((e) => console.warn("Apple Intelligence state:", e));
    check();
    const id = setInterval(check, APPLE_RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [appleSettled, visible]);
  const c = useCleanupChooser({
    ...opening,
    savedKey,
    active: wantOn && visible,
    appleState,
  });

  // Is this choice already what the settings hold?
  const isSaved = (choice: CleanupChoice) => {
    if (!enabled) return false;
    switch (choice.kind) {
      case "s1":
        return savedProvider === VOCE_LOCAL;
      case "apple":
        return savedProvider === "apple_intelligence";
      case "local":
        return (
          savedProvider === "custom" &&
          custom?.base_url === choice.baseUrl &&
          settings.post_process_models?.custom === choice.model
        );
      case "cloud":
        // Same provider, same model, no new key (review N4).
        return (
          savedProvider === choice.provider &&
          settings.post_process_models?.[choice.provider] === choice.model &&
          !c.key
        );
      default:
        return false;
    }
  };

  // Test, then save: a passed test of a new choice (or of turning on) is
  // saved by its request id, so a late or failed result saves nothing.
  const savingId = useRef(0);
  useEffect(() => {
    const test = c.test;
    // Only after the user changed something: opening the page saves nothing.
    if (!wantOn || !visible || test?.status !== "passed" || c.touched === 0)
      return;
    const choice = c.choice();
    if (!choice || isSaved(choice) || savingId.current === test.id) return;
    savingId.current = test.id;
    api
      .saveCleanupChoice(choice, test.id)
      .then(refreshSettings)
      .catch((e) => {
        console.warn("Saving the cleanup choice:", e);
        toast.error(t("onboarding.cleanup.saveFailed"));
      });
    // isSaved reads the settings this render holds
  }, [c.test, wantOn, c.touched, visible]);

  const toggle = async (on: boolean) => {
    setWantOn(on);
    c.reset();
    c.touch();
    if (on) return; // the live test runs, then saves
    try {
      await api.saveCleanupChoice({ kind: "off" }, 0);
      await refreshSettings();
    } catch (e) {
      console.warn("Turning cleanup off:", e);
      setWantOn(true);
    }
  };

  // ---- Clean while you talk: Voce cleanup and local servers only ----
  // The backend says what runs for the saved choice (test app bug 2); a
  // choice not saved yet follows the same rule.
  const [earlyState, setEarlyState] = useState<{
    enabled: boolean;
    available: boolean;
    effective: boolean;
  } | null>(null);
  const loadEarly = () =>
    api
      .getEarlyCleanup()
      .then(setEarlyState)
      .catch((e) => console.warn("Clean while you talk:", e));
  useEffect(() => {
    loadEarly();
  }, [settings]);
  const early = earlyState?.enabled ?? settings.early_cleanup ?? true;
  const selectionSaved = (() => {
    const choice = c.choice();
    return !!choice && choice.kind !== "off" && isSaved(choice);
  })();
  const earlySupported = selectionSaved
    ? (earlyState?.available ?? true)
    : c.opt === "s1" || c.opt === "local";
  const earlyShown = !wantOn
    ? early
    : selectionSaved && earlyState
      ? earlyState.effective
      : early && earlySupported;
  const changeEarly = async (on: boolean) => {
    setEarlyState((s) => (s ? { ...s, enabled: on, effective: on } : s));
    try {
      await api.setEarlyCleanup(on);
      await refreshSettings();
    } catch (e) {
      console.warn("Clean while you talk:", e);
    } finally {
      loadEarly();
    }
  };

  // ---- style: s1-mini's control line ----
  const [control, setControl] = useState<S1Control>({
    styling: settings.s1_styling ?? "semi-formal",
    structure: settings.s1_structure ?? "prose",
    context: settings.s1_context ?? "general",
  });
  const changeControl = async (next: S1Control) => {
    const before = control;
    setControl(next);
    try {
      await api.setS1Control(next);
      await refreshSettings();
      if (c.opt === "s1") c.reset(); // the live test shows the new style
    } catch (e) {
      console.warn("Style:", e);
      setControl(before);
    }
  };
  const styleActive =
    c.opt === "s1" || (c.opt === "local" && /s1-mini/i.test(c.localModel));

  const off = !wantOn;
  const dim = off ? "dim" : "";

  const seg = <K extends keyof S1Control>(
    k: K,
    values: S1Control[K][],
    label: string,
  ) => (
    <div className="v-row">
      <span className="v-lbl">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {values.map((v) => (
          <button
            type="button"
            key={v}
            aria-pressed={control[k] === v}
            onClick={() => changeControl({ ...control, [k]: v })}
          >
            {t(`settings.cleanup.style.${k}.${v}`)}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="vcl">
      <PageHeader title={t("settings.cleanup.title")} />

      <div className="v-group">
        <div className="v-row tall">
          <div className="lb">
            <div className="v-lbl">{t("settings.cleanup.switch.label")}</div>
            <div className="sub">
              {wantOn && !enabled
                ? t("settings.cleanup.switch.pending")
                : t("settings.cleanup.switch.sub")}
            </div>
          </div>
          <Switch
            checked={wantOn}
            onChange={toggle}
            label={t("settings.cleanup.switch.label")}
          />
        </div>
        <div className={`v-row tall ${dim}`} {...inert(off)}>
          <div className="lb">
            <div className="v-lbl">{t("settings.cleanup.early.label")}</div>
            <div className="sub">
              {earlySupported
                ? t("settings.cleanup.early.sub")
                : t("settings.cleanup.early.unsupported")}
            </div>
          </div>
          <Switch
            checked={earlyShown}
            onChange={changeEarly}
            disabled={!earlySupported}
            label={t("settings.cleanup.early.label")}
          />
        </div>
      </div>

      <div className={dim} {...inert(off)}>
        <div className="v-gl">{t("settings.cleanup.model")}</div>
        <div className="model">
          <CleanupOptions
            c={c}
            compact
            showOff={false}
            showApple={!!appleState && appleState !== "unsupported"}
            showCustom
          />
          <LiveTest c={c} canRerun arrowSize={14} off={off} />
        </div>
      </div>

      <div className={dim} {...inert(off)}>
        <div className="v-gl">{t("settings.cleanup.style.title")}</div>
        <div
          className={`v-group ${styleActive ? "" : "dim"}`}
          {...inert(!styleActive)}
        >
          {seg("styling", STYLES, t("settings.cleanup.style.styling.label"))}
          {seg(
            "structure",
            STRUCTURES,
            t("settings.cleanup.style.structure.label"),
          )}
          {seg("context", CONTEXTS, t("settings.cleanup.style.context.label"))}
          <div className="prev">
            <div className="k">
              <I icon={Eye} />
              {t("settings.cleanup.style.preview")}
            </div>
            <StylePreview control={control} />
          </div>
        </div>
        {!styleActive && (
          <p className="why">{t("settings.cleanup.style.otherModels")}</p>
        )}
      </div>

      <div className="v-gl">{t("settings.cleanup.shortcuts")}</div>
      <div className="v-group shortcuts">
        <ShortcutInput
          shortcutId="transcribe"
          descriptionMode="inline"
          grouped
          hideReset
          title={t("settings.cleanup.dictate.label")}
          description={t("settings.cleanup.dictate.sub")}
        />
        <div className={dim} {...inert(off)}>
          <ShortcutInput
            shortcutId="transcribe_with_post_process"
            descriptionMode="inline"
            grouped
            hideReset
            title={t("settings.cleanup.raw.label")}
            description={t("settings.cleanup.raw.sub")}
          />
        </div>
      </div>

      <Advanced
        c={c}
        settings={settings}
        dim={off}
        onChanged={refreshSettings}
        updateBaseUrl={updatePostProcessBaseUrl}
        updateKey={updatePostProcessApiKey}
      />
    </div>
  );
};

/** One made-up sentence in each style, as the mockup shows it. */
const StylePreview: React.FC<{ control: S1Control }> = ({ control }) => {
  const { t } = useTranslation();
  const k = `settings.cleanup.style.samples.${control.styling}`;
  const lines = t(`${k}.list`, { returnObjects: true }) as string[];
  const body =
    control.structure === "lists" ? (
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    ) : (
      <p>{t(`${k}.prose`)}</p>
    );
  return (
    <div className="txt">
      {control.context === "email" ? (
        <>
          <p>{t(`${k}.hi`)}</p>
          {body}
          <p>{t(`${k}.bye`)}</p>
        </>
      ) : (
        body
      )}
    </div>
  );
};

interface AdvancedProps {
  c: Chooser;
  settings: Settings;
  dim: boolean;
  onChanged: () => Promise<void>;
  updateBaseUrl: (providerId: string, baseUrl: string) => Promise<void>;
  updateKey: (providerId: string, apiKey: string) => Promise<void>;
}

/** Base URL, model name, the key (never shown) and custom instructions. */
const Advanced: React.FC<AdvancedProps> = ({
  c,
  settings,
  dim,
  onChanged,
  updateBaseUrl,
  updateKey,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  // A custom server is set up here: open the fields it needs.
  const needsServer = c.opt === "local" && !c.choice();
  useEffect(() => {
    if (needsServer) setOpen(true);
  }, [needsServer]);
  const pid = providerOf(c);
  // Voce cleanup and Apple Intelligence run on this Mac with no endpoint,
  // key or prompt to edit.
  const isS1 = c.opt === "s1" || c.opt === "apple";
  const provider = settings.post_process_providers?.find((p) => p.id === pid);
  const baseUrl =
    c.opt === "local" ? (c.server?.baseUrl ?? "") : (provider?.base_url ?? "");
  const model = c.opt === "local" ? c.localModel : c.cloudModel(pid);
  const hasKey = !!settings.post_process_api_keys?.[pid];
  // The prompt dictation uses: the selected one.
  const prompt =
    settings.post_process_prompts?.find(
      (p) => p.id === settings.post_process_selected_prompt_id,
    ) ?? settings.post_process_prompts?.find((p) => p.id === DEFAULT_PROMPT_ID);
  const [instructions, setInstructions] = useState(prompt?.prompt ?? "");
  useEffect(() => setInstructions(prompt?.prompt ?? ""), [prompt?.prompt]);

  const saveKey = async (value: string) => {
    setReplacing(false);
    const k = value.trim();
    if (!k) return;
    // A cloud key goes through the live test and is saved when it passes.
    if (c.opt === "cloud") c.setKey(k);
    else {
      await updateKey(pid, k);
      await onChanged();
    }
  };

  return (
    <div className={`v-group ${dim ? "dim" : ""}`} {...inert(dim)}>
      <button
        type="button"
        className="v-row fold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="v-lbl">{t("settings.cleanup.advanced.title")}</span>
        <I icon={ChevronDown} />
      </button>
      {open && !isS1 && (
        <div className="v-row">
          <span className="v-lbl">
            {t("settings.cleanup.advanced.baseUrl")}
          </span>
          {c.opt === "local" ? (
            <input
              className="v-field wide mono"
              defaultValue={baseUrl}
              key={baseUrl}
              spellCheck={false}
              aria-label={t("settings.cleanup.advanced.baseUrl")}
              onBlur={async (e) => {
                const v = e.target.value.trim();
                if (v === baseUrl) return;
                // The next test goes to the new endpoint.
                c.setServerBaseUrl(v);
                await updateBaseUrl("custom", v);
                await onChanged();
              }}
            />
          ) : (
            <div className="v-field wide mono">{baseUrl}</div>
          )}
        </div>
      )}
      {open && (
        <div className="v-row">
          <span className="v-lbl">{t("settings.cleanup.advanced.model")}</span>
          {isS1 ? (
            <div className="v-field wide mono">
              {c.opt === "apple"
                ? t("onboarding.cleanup.apple.name")
                : t("onboarding.cleanup.s1.model")}
            </div>
          ) : (
            <input
              className="v-field wide mono"
              defaultValue={model}
              key={`${pid}:${model}`}
              spellCheck={false}
              aria-label={t("settings.cleanup.advanced.model")}
              onBlur={async (e) => {
                const v = e.target.value.trim();
                if (v === model) return;
                if (c.opt === "local") c.setLocalModel(v);
                // A cloud model is tested, then saved with the choice.
                else c.pickCloudModel(pid, v);
              }}
            />
          )}
        </div>
      )}
      {open && !isS1 && (
        <div className="v-row">
          <span className="v-lbl">{t("settings.cleanup.advanced.apiKey")}</span>
          <div className="v-ctl">
            {replacing ? (
              <input
                type="password"
                className="v-field wide mono"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder={t("onboarding.cleanup.cloud.keyPlaceholder")}
                aria-label={t("settings.cleanup.advanced.apiKey")}
                onBlur={(e) => saveKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setReplacing(false);
                }}
              />
            ) : (
              <>
                <span className="keyok">
                  <I icon={Lock} />
                  {hasKey
                    ? t("settings.cleanup.advanced.keySaved")
                    : t("settings.cleanup.advanced.noKey")}
                </span>
                <button
                  type="button"
                  className="v-btn v-secondary"
                  onClick={() => setReplacing(true)}
                >
                  {hasKey
                    ? t("settings.cleanup.advanced.replace")
                    : t("settings.cleanup.advanced.add")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {open && !isS1 && (
        <div className="v-row v-stack">
          <div className="lb" style={{ marginBottom: 10 }}>
            <div className="v-lbl">
              {t("settings.cleanup.advanced.instructions")}
            </div>
            <div className="sub">
              {t("settings.cleanup.advanced.instructionsSub")}
            </div>
          </div>
          <textarea
            className="v-field"
            spellCheck={false}
            value={instructions}
            aria-label={t("settings.cleanup.advanced.instructions")}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={async () => {
              if (!prompt || instructions === prompt.prompt) return;
              await commands.updatePostProcessPrompt(
                prompt.id,
                prompt.name,
                instructions,
              );
              await onChanged();
              c.reset();
            }}
          />
        </div>
      )}
    </div>
  );
};
