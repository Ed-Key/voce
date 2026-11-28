import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronLeft,
  Keyboard,
  LoaderCircle,
  Mic,
  type LucideIcon,
} from "lucide-react";
import { api, type Permissions as Granted } from "./api";
import { BackButton, Frame, I, type StepProps } from "./Frame";
import appIcon from "./assets/app-icon.png";

type Kind = keyof Granted;
/** needed: Allow button; waiting: asked, polling; denied: still off after
 *  asking, says where to turn it on and offers Retry. */
type Status = "checking" | "needed" | "waiting" | "denied" | "granted";

const POLL_MS = 1000;
// macOS gives no "denied" answer for these; stop waiting after a while so the
// screen never waits forever (table row 4c).
const GIVE_UP_MS: Record<Kind, number> = {
  microphone: 30_000,
  accessibility: 120_000,
};
const MAX_CHECK_ERRORS = 3;

const Permissions: React.FC<StepProps & { step: number }> = ({
  onNext,
  onBack,
  step,
}) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Record<Kind, Status>>({
    microphone: "checking",
    accessibility: "checking",
  });
  const [checkFailed, setCheckFailed] = useState(false);
  const waitingSince = useRef<Partial<Record<Kind, number>>>({});
  const errors = useRef(0);

  const check = useCallback(async () => {
    try {
      const granted = await api.checkPermissions();
      errors.current = 0;
      setCheckFailed(false);
      setStatus((prev) => {
        const next = { ...prev };
        (Object.keys(granted) as Kind[]).forEach((k) => {
          if (granted[k]) next[k] = "granted";
          else if (prev[k] === "checking" || prev[k] === "granted")
            next[k] = "needed";
          else if (
            prev[k] === "waiting" &&
            Date.now() - (waitingSince.current[k] ?? 0) > GIVE_UP_MS[k]
          )
            next[k] = "denied";
        });
        return next;
      });
    } catch (e) {
      console.warn("Permission check failed:", e);
      errors.current += 1;
      if (errors.current >= MAX_CHECK_ERRORS) setCheckFailed(true);
      setStatus((prev) => ({
        microphone: prev.microphone === "checking" ? "needed" : prev.microphone,
        accessibility:
          prev.accessibility === "checking" ? "needed" : prev.accessibility,
      }));
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  // Poll while anything is waiting, so a grant in System Settings flips the
  // row without a relaunch (row 5).
  const anyWaiting =
    status.microphone === "waiting" || status.accessibility === "waiting";
  useEffect(() => {
    if (!anyWaiting || checkFailed) return;
    const id = setInterval(check, POLL_MS);
    return () => clearInterval(id);
  }, [anyWaiting, checkFailed, check]);

  const ask = async (kind: Kind) => {
    const denied = status[kind] === "denied";
    waitingSince.current[kind] = Date.now();
    errors.current = 0;
    setCheckFailed(false);
    setStatus((prev) => ({ ...prev, [kind]: "waiting" }));
    try {
      if (denied) await api.openPrivacySettings(kind);
      else if (kind === "microphone") await api.requestMicrophone();
      else await api.requestAccessibility();
    } catch (e) {
      console.warn(`Permission request failed (${kind}):`, e);
      setStatus((prev) => ({ ...prev, [kind]: "denied" }));
    }
  };

  const allGranted =
    status.microphone === "granted" && status.accessibility === "granted";

  const row = (kind: Kind, icon: LucideIcon) => {
    const s = status[kind];
    return (
      <div className="prow">
        <span className="ico">
          <I icon={icon} s={18} />
        </span>
        <div className="txt">
          <h3>{t(`onboarding.permissions.${kind}.title`)}</h3>
          <p>{t(`onboarding.permissions.${kind}.description`)}</p>
        </div>
        <div className="act">
          {s === "needed" && (
            <button
              type="button"
              className="v-btn v-primary"
              onClick={() => ask(kind)}
            >
              {t("onboarding.permissions.allow")}
            </button>
          )}
          {s === "denied" && (
            <button
              type="button"
              className="v-btn v-secondary"
              onClick={() => ask(kind)}
            >
              {t("onboarding.retry")}
            </button>
          )}
          {(s === "waiting" || s === "checking") && (
            <span className="wait">
              <I icon={LoaderCircle} className="spin" />
              {t("onboarding.permissions.waiting")}
            </span>
          )}
          {s === "granted" && (
            <span className="ok">
              <I icon={Check} />
              {t("onboarding.permissions.allowed")}
            </span>
          )}
        </div>
      </div>
    );
  };

  // The System Settings row the user is about to flip.
  const sys = (kind: Kind) => {
    const s = status[kind];
    const show =
      kind === "accessibility"
        ? s === "waiting" || s === "denied"
        : s === "denied";
    if (!show) return null;
    return (
      <div className="sys">
        <div className="path">
          {t("onboarding.permissions.sys.settings")}
          <I icon={ChevronLeft} />
          {t("onboarding.permissions.sys.privacy")}
          <I icon={ChevronLeft} />
          {t(`onboarding.permissions.${kind}.pane`)}
        </div>
        <div className="row">
          <img src={appIcon} alt="" />
          <span className="g">{t("onboarding.permissions.sys.app")}</span>
          <span className="tg" />
        </div>
        <div className="hint">
          {s === "denied"
            ? t(`onboarding.permissions.${kind}.denied`)
            : t("onboarding.permissions.sys.hint")}
        </div>
      </div>
    );
  };

  return (
    <Frame
      screen="perm"
      step={step}
      foot={
        <>
          <BackButton onClick={onBack} />
          <span className="grow" />
          {checkFailed && (
            <span className="note">
              {t("onboarding.permissions.checkFailed")}{" "}
              <button
                type="button"
                className="v-btn v-ghost"
                onClick={() => {
                  errors.current = 0;
                  setCheckFailed(false);
                  check();
                }}
              >
                {t("onboarding.retry")}
              </button>
            </span>
          )}
          <button
            type="button"
            className="v-btn v-primary lg"
            disabled={!allGranted}
            onClick={onNext}
          >
            {t("onboarding.continue")}
          </button>
        </>
      }
    >
      <div className="hd">
        <h1>{t("onboarding.permissions.title")}</h1>
        <p>{t("onboarding.permissions.description")}</p>
      </div>
      <div className="col">
        <div className="v-group">
          <div>
            {row("microphone", Mic)}
            {sys("microphone")}
          </div>
          <div>
            {row("accessibility", Keyboard)}
            {sys("accessibility")}
          </div>
        </div>
      </div>
    </Frame>
  );
};

export default Permissions;
