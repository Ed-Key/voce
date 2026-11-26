import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { SettingContainer } from "../ui/SettingContainer";

interface HistoryLimitProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

export const HistoryLimit: React.FC<HistoryLimitProps> = ({
  descriptionMode = "inline",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const historyLimit = getSetting("history_limit") ?? 5000;

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(event.target.value, 10);
    if (!isNaN(value) && value >= 0) {
      updateSetting("history_limit", value);
    }
  };

  return (
    <SettingContainer
      title={t("settings.debug.historyLimit.title")}
      description={t("settings.debug.historyLimit.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="horizontal"
    >
      <label className="v-field w-[108px]">
        <input
          type="number"
          min="0"
          max="10000"
          value={historyLimit}
          onChange={handleChange}
          disabled={isUpdating("history_limit")}
          aria-label={t("settings.debug.historyLimit.title")}
          className="w-full min-w-0 bg-transparent outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-text-3 font-normal">
          {t("settings.debug.historyLimit.entries")}
        </span>
      </label>
    </SettingContainer>
  );
};
