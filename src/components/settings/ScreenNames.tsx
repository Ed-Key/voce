import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface ScreenNamesProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/** The onboarding Names switch, also here: a user migrated past onboarding
 *  has it on by default and needs a way to turn it off (onboarding row 24). */
export const ScreenNames: React.FC<ScreenNamesProps> = React.memo(
  ({ descriptionMode = "inline", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    return (
      <ToggleSwitch
        checked={getSetting("screen_names") ?? true}
        onChange={(enabled) => updateSetting("screen_names", enabled)}
        isUpdating={isUpdating("screen_names")}
        label={t("onboarding.names.setting")}
        description={t("onboarding.names.settingHint")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);
