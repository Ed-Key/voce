import React from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  Check,
  Download,
  Globe,
  Languages,
  Loader2,
  Trash2,
} from "lucide-react";
import type { ModelInfo } from "@/bindings";
import type { ModelCardStatus } from "@/components/onboarding";
import { isLegacySource } from "@/components/onboarding/ModelCard";
import { formatModelSize } from "@/lib/utils/format";
import {
  getTranslatedModelDescription,
  getTranslatedModelName,
} from "@/lib/utils/modelTranslation";
import {
  getLanguageLabel,
  getUniqueCapabilityLanguages,
} from "@/lib/constants/languages";
import { Button } from "../../ui/Button";

interface ModelRowProps {
  model: ModelInfo;
  status: ModelCardStatus;
  onSelect: (modelId: string) => void;
  onDownload: (modelId: string) => void;
  onDelete: (modelId: string) => void;
  onCancel: (modelId: string) => void;
  downloadProgress?: number;
  downloadSpeed?: number;
}

const Meter: React.FC<{ label: string; value: number }> = ({
  label,
  value,
}) => (
  <>
    <span>{label}</span>
    <div className="h-[3px] rounded-sm bg-track overflow-hidden">
      <div
        className="h-full rounded-sm bg-text-2"
        style={{ width: `${value * 100}%` }}
      />
    </div>
  </>
);

/** One model in the Models page list: name, what it does, meters, one action. */
export const ModelRow: React.FC<ModelRowProps> = ({
  model,
  status,
  onSelect,
  onDownload,
  onDelete,
  onCancel,
  downloadProgress,
  downloadSpeed,
}) => {
  const { t } = useTranslation();
  const name = getTranslatedModelName(model, t);
  const languages = getUniqueCapabilityLanguages(model.supported_languages);
  const isActive = status === "active";
  // The active model is already loaded, so only other models are clickable.
  const isClickable = status === "available" || status === "downloadable";
  const busy =
    status === "downloading" ||
    status === "verifying" ||
    status === "extracting";

  const activate = () => {
    if (status === "downloadable") onDownload(model.id);
    else if (status === "available") onSelect(model.id);
  };

  const languageText =
    languages.length === 1
      ? t("modelSelector.capabilities.languageOnly", {
          language: getLanguageLabel(languages[0]) || languages[0],
        })
      : t("modelSelector.capabilities.languageCount", {
          total: languages.length,
        });

  return (
    <div
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable ? activate : undefined}
      onKeyDown={(e) => {
        if (isClickable && e.key === "Enter") activate();
      }}
      className={`v-row py-[13px] gap-5 transition-colors ${
        isActive ? "bg-accent-wash rounded-[11px]" : ""
      } ${isClickable ? "cursor-pointer hover:bg-hover" : ""}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 text-[14.5px] leading-5 font-semibold">
          <span className="truncate">{name}</span>
          {isActive && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-accent">
              <Check width={12} height={12} strokeWidth={2.4} />
              {t("modelSelector.active")}
            </span>
          )}
          {status === "switching" && (
            <span className="inline-flex items-center gap-1 v-meta">
              <Loader2 width={12} height={12} className="animate-spin" />
              {t("modelSelector.switching")}
            </span>
          )}
          {model.is_custom && (
            <span className="v-meta">{t("modelSelector.custom")}</span>
          )}
          {isLegacySource(model) && (
            <span className="v-meta">{t("modelSelector.legacy")}</span>
          )}
        </div>
        <p className="text-[13px] leading-[18px] text-text-2 mt-px">
          {getTranslatedModelDescription(model, t)}
        </p>
        <div className="flex gap-3.5 mt-[7px] v-meta">
          {languages.length > 0 && (
            <span className="inline-flex items-center gap-[5px]">
              <Globe width={13} height={13} strokeWidth={1.6} />
              {languageText}
            </span>
          )}
          {model.supports_streaming && (
            <span className="inline-flex items-center gap-[5px]">
              <AudioLines width={13} height={13} strokeWidth={1.6} />
              {t("modelSelector.streaming")}
            </span>
          )}
          {model.supports_translation && (
            <span className="inline-flex items-center gap-[5px]">
              <Languages width={13} height={13} strokeWidth={1.6} />
              {t("modelSelector.capabilities.translate")}
            </span>
          )}
          {!busy && <span>{formatModelSize(Number(model.size_mb))}</span>}
        </div>
        {busy && (
          <div className="mt-2.5">
            <div className="h-[3px] rounded-sm bg-track overflow-hidden">
              <div
                className={`h-full rounded-sm bg-accent transition-all duration-300 ${
                  status === "downloading" ? "" : "w-full animate-pulse"
                }`}
                style={
                  status === "downloading"
                    ? { width: `${downloadProgress ?? 0}%` }
                    : undefined
                }
              />
            </div>
            <div className="flex items-center justify-between mt-1 v-meta">
              <span>
                {status === "downloading"
                  ? t("modelSelector.downloading", {
                      percentage: Math.round(downloadProgress ?? 0),
                    })
                  : status === "verifying"
                    ? t("modelSelector.verifyingGeneric")
                    : t("modelSelector.extractingGeneric")}
              </span>
              {status === "downloading" && (
                <span className="flex items-center gap-2">
                  {downloadSpeed !== undefined && downloadSpeed > 0 && (
                    <span className="tabular-nums">
                      {t("modelSelector.downloadSpeed", {
                        speed: downloadSpeed.toFixed(1),
                      })}
                    </span>
                  )}
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancel(model.id);
                    }}
                    aria-label={t("modelSelector.cancelDownload")}
                  >
                    {t("modelSelector.cancel")}
                  </Button>
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {(model.accuracy_score > 0 || model.speed_score > 0) && (
        <div className="grid grid-cols-[auto_56px] gap-x-2 gap-y-[7px] items-center text-[11.5px] leading-3 text-text-3 text-right">
          <Meter
            label={t("settings.models.meters.accuracy")}
            value={model.accuracy_score}
          />
          <Meter
            label={t("settings.models.meters.speed")}
            value={model.speed_score}
          />
        </div>
      )}
      {(status === "active" || status === "available") && (
        <button
          type="button"
          className="v-ib -me-1.5 text-text-2"
          title={t("modelSelector.deleteModel", { modelName: name })}
          aria-label={t("modelSelector.deleteModel", { modelName: name })}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(model.id);
          }}
        >
          <Trash2 width={15} height={15} strokeWidth={1.6} />
        </button>
      )}
      {status === "downloadable" && (
        <button
          type="button"
          className="v-ib -me-1.5 text-text-2"
          title={t("settings.models.download", { modelName: name })}
          aria-label={t("settings.models.download", { modelName: name })}
          onClick={(e) => {
            e.stopPropagation();
            onDownload(model.id);
          }}
        >
          <Download width={15} height={15} strokeWidth={1.6} />
        </button>
      )}
    </div>
  );
};
