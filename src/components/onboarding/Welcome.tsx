import React from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Download,
  Eye,
  HardDrive,
  Keyboard,
  Mic,
  Sparkles,
} from "lucide-react";
import VoceWordmark from "../icons/VoceWordmark";
import { Frame, I, type StepProps } from "./Frame";

const Welcome: React.FC<StepProps> = ({ onNext }) => {
  const { t } = useTranslation();
  const steps = [
    { icon: Mic, label: t("onboarding.welcome.steps.access") },
    { icon: Download, label: t("onboarding.welcome.steps.model") },
    { icon: Sparkles, label: t("onboarding.welcome.steps.cleanup") },
    { icon: Keyboard, label: t("onboarding.welcome.steps.try") },
    { icon: Eye, label: t("onboarding.welcome.steps.names") },
    { icon: HardDrive, label: t("onboarding.welcome.steps.storage") },
  ];
  return (
    <Frame screen="welcome" step={0}>
      <div className="wm-slot">
        <VoceWordmark width={176} />
      </div>
      <div className="hd">
        <h1>{t("onboarding.welcome.title")}</h1>
      </div>
      <div className="next six" aria-label={t("onboarding.welcome.stepsLabel")}>
        {steps.map(({ icon, label }) => (
          <div key={label}>
            <span>
              <I icon={icon} s={18} />
            </span>
            {label}
          </div>
        ))}
      </div>
      <div className="go">
        <button
          type="button"
          className="v-btn v-primary lg"
          onClick={onNext}
          autoFocus
        >
          {t("onboarding.welcome.start")}
          <I icon={ArrowRight} />
        </button>
        <p>{t("onboarding.welcome.note")}</p>
      </div>
    </Frame>
  );
};

export default Welcome;
