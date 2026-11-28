import React from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, type LucideIcon } from "lucide-react";

/** A Lucide icon drawn like the mockups' sprite (16 px, 1.6 stroke). */
export const I: React.FC<{
  icon: LucideIcon;
  s?: number;
  className?: string;
}> = ({ icon: Icon, s = 16, className = "" }) => (
  <Icon
    className={`i ${className}`}
    width={s}
    height={s}
    strokeWidth={1.6}
    style={{ width: s, height: s }}
    aria-hidden
  />
);

interface FrameProps {
  /** Screen class suffix: the CSS for each screen is scoped to .vob-<screen>. */
  screen: string;
  /** Position on the step meter (1 to 6); 0 hides the meter. */
  step: number;
  state?: string;
  className?: string;
  style?: React.CSSProperties;
  stageClass?: string;
  foot?: React.ReactNode;
  footClass?: string;
  footStyle?: React.CSSProperties;
  children: React.ReactNode;
}

export const METER_STEPS = 6;

/** The onboarding window: drag strip, step meter, centered stage, footer. */
export const Frame: React.FC<FrameProps> = ({
  screen,
  step,
  state,
  className = "",
  style,
  stageClass = "",
  foot,
  footClass = "",
  footStyle,
  children,
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={`vob vob-${screen} ${className}`}
      data-state={state}
      style={style}
    >
      <div data-tauri-drag-region className="drag" />
      {step > 0 && (
        <div
          className="steps"
          role="img"
          aria-label={t("onboarding.stepOf", {
            step,
            total: METER_STEPS,
          })}
        >
          {Array.from({ length: METER_STEPS }, (_, i) => (
            <i
              key={i}
              className={
                i + 1 < step ? "done" : i + 1 === step ? "on" : undefined
              }
            />
          ))}
        </div>
      )}
      <div className={`stage ${stageClass}`}>{children}</div>
      {foot && (
        <div className={`foot ${footClass}`} style={footStyle}>
          {foot}
        </div>
      )}
    </div>
  );
};

export const BackButton: React.FC<{ onClick?: () => void }> = ({ onClick }) => {
  const { t } = useTranslation();
  if (!onClick) return null;
  return (
    <button type="button" className="v-btn v-ghost lg" onClick={onClick}>
      <I icon={ChevronLeft} />
      {t("onboarding.back")}
    </button>
  );
};

/** Shared by every step: move on, or go back one. */
export interface StepProps {
  onNext: () => void;
  onBack?: () => void;
}

const MB = 1_000_000;

/** "248", "0.4": the mockups' MB figures. */
export const mb = (bytes: number) => {
  const v = bytes / MB;
  return v < 1 ? v.toFixed(1) : Math.round(v).toString();
};
