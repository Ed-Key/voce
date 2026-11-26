import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { emit } from "@tauri-apps/api/event";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { PageHeader } from "../../ui/PageHeader";
import { Button } from "../../ui/Button";
import { AppDataDirectory } from "../AppDataDirectory";
import { ShowWhatsNewOnUpdate } from "../ShowWhatsNewOnUpdate";
import { UpdateChecksToggle } from "../UpdateChecksToggle";
import { LogDirectory } from "../debug";
import { useSettings } from "../../../hooks/useSettings";
// The app icon carries the standard macOS margin, so it is drawn larger.
import appIcon from "../../../../src-tauri/icons/128x128@2x.png";

export const AboutSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateChecksLocked } = useSettings();
  const [version, setVersion] = useState("");
  const canCheck =
    updateChecksLocked === false &&
    (getSetting("update_checks_enabled") ?? true);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((error) => console.error("Failed to get app version:", error));
  }, []);

  return (
    <div className="w-full">
      <PageHeader title={t("settings.about.title")} />
      <div className="flex items-center gap-4 mt-1 mb-[33px] ms-1.5">
        <img
          src={appIcon}
          alt=""
          width={92}
          height={92}
          className="block -m-2"
        />
        <div>
          {/* eslint-disable-next-line i18next/no-literal-string */}
          <div className="text-[22px] leading-[26px] font-[640] tracking-[-0.012em]">
            Voce
          </div>
          {version && (
            <div className="v-meta mt-[3px]">
              {t("settings.about.versionLine", { version })}
            </div>
          )}
        </div>
      </div>

      <SettingsGroup title={t("settings.about.groups.updates")}>
        <div className="relative">
          <UpdateChecksToggle descriptionMode="tooltip" grouped={true} />
          {canCheck && (
            <Button
              variant="ghost"
              className="absolute end-[64px] top-1/2 -translate-y-1/2"
              onClick={() => void emit("check-for-updates")}
            >
              {t("settings.about.checkNow")}
            </Button>
          )}
        </div>
        <ShowWhatsNewOnUpdate descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.about.groups.data")}>
        <AppDataDirectory descriptionMode="tooltip" grouped={true} />
        <LogDirectory grouped={true} />
      </SettingsGroup>

      <p className="v-meta text-[12.5px] leading-[18px] mx-3.5 max-w-[520px]">
        {t("settings.about.acknowledgments.ggml.details")}
      </p>
    </div>
  );
};
