import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../../ui/Dropdown";
import { SettingContainer } from "../../ui/SettingContainer";
import { STEPS, type OnboardingStep } from "../../onboarding/api";

export type OnboardingPreviewStep = Exclude<OnboardingStep, "done">;

interface OnboardingPreviewProps {
  onPreview: (step: OnboardingPreviewStep) => void;
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const OnboardingPreview: React.FC<OnboardingPreviewProps> = ({
  onPreview,
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const steps = STEPS.filter((s): s is OnboardingPreviewStep => s !== "done");

  return (
    <SettingContainer
      title={t("settings.debug.onboardingPreview.title")}
      description={t("settings.debug.onboardingPreview.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    >
      <Dropdown
        options={steps.map((s) => ({
          value: s,
          label: t(`settings.debug.onboardingPreview.steps.${s}`),
        }))}
        selectedValue={null}
        placeholder={t("settings.debug.onboardingPreview.pick")}
        onSelect={(s) => onPreview(s as OnboardingPreviewStep)}
      />
    </SettingContainer>
  );
};
