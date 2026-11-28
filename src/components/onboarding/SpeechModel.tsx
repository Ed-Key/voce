import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  ChevronDown,
  Download,
  Globe,
  HardDrive,
} from "lucide-react";
import type { ModelInfo } from "@/bindings";
import { useModelStore } from "@/stores/modelStore";
import {
  getTranslatedModelDescription,
  getTranslatedModelName,
} from "@/lib/utils/modelTranslation";
import { isLegacySource } from "./ModelCard";
import { BackButton, Frame, I, mb, type StepProps } from "./Frame";

interface Props extends StepProps {
  step: number;
  /** The model being downloaded or chosen; selected once it is on disk. */
  pending: string | null;
  setPending: (modelId: string) => void;
}

const FEATURED = 2;

/** "about 20 s left" / "about 3 min left", from bytes left and MB/s. */
export const useEta = () => {
  const { t } = useTranslation();
  return (bytesLeft: number, mbPerSec: number | undefined) => {
    if (!mbPerSec || mbPerSec <= 0 || bytesLeft <= 0) return null;
    const s = bytesLeft / (mbPerSec * 1024 * 1024);
    return s < 90
      ? t("onboarding.etaSeconds", { count: Math.max(1, Math.round(s)) })
      : t("onboarding.etaMinutes", { count: Math.round(s / 60) });
  };
};

const SpeechModel: React.FC<Props> = ({
  step,
  onNext,
  onBack,
  pending,
  setPending,
}) => {
  const { t, i18n } = useTranslation();
  const {
    models,
    currentModel,
    downloadModel,
    cancelDownload,
    downloadingModels,
    verifyingModels,
    extractingModels,
    downloadProgress,
    downloadStats,
  } = useModelStore();
  const eta = useEta();
  const [sel, setSel] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [failed, setFailed] = useState<Record<string, true>>({});
  // The store drops progress when a download fails; keep the last figures so
  // the failed row can say where it stopped.
  const lastProgress = useRef<Record<string, { done: number; total: number }>>(
    {},
  );

  // Featured: the first recommended models, plus anything already on disk
  // (marked Downloaded, row 10). The rest hide behind "Show all".
  const { featured, rest } = useMemo(() => {
    const listed = models.filter((m) => m.is_downloaded || !isLegacySource(m));
    const top = listed.filter((m) => m.is_recommended).slice(0, FEATURED);
    // One model already on this Mac joins the picks (the active one first);
    // a big shared cache stays behind "Show all", not in the collapsed list.
    const onDisk = listed.filter((m) => m.is_downloaded && !top.includes(m));
    const featured = [
      ...top,
      ...((onDisk.find((m) => m.id === currentModel) ?? onDisk[0])
        ? [onDisk.find((m) => m.id === currentModel) ?? onDisk[0]]
        : []),
    ];
    return {
      featured,
      rest: listed.filter((m) => !featured.includes(m)),
    };
  }, [models, currentModel]);

  // The pending model (its download resumed by the controller) is the pick.
  const pickedPending = useRef(false);
  useEffect(() => {
    if (pickedPending.current || !pending) return;
    if (!models.some((x) => x.id === pending)) return;
    pickedPending.current = true;
    setSel(pending);
  }, [pending, models]);

  // Default pick: the active model, else something on disk, else the top pick.
  useEffect(() => {
    if (sel || models.length === 0) return;
    const ready = models.find((m) => m.id === currentModel && m.is_downloaded);
    setSel(
      ready?.id ??
        models.find((m) => m.id in downloadingModels)?.id ??
        featured.find((m) => m.is_downloaded)?.id ??
        featured[0]?.id ??
        null,
    );
  }, [sel, models, currentModel, downloadingModels, featured]);

  Object.values(downloadProgress).forEach((p) => {
    if (p.total > 0)
      lastProgress.current[p.model_id] = { done: p.downloaded, total: p.total };
  });

  const busyId = Object.keys(downloadingModels)[0] ?? null;
  const selModel = models.find((m) => m.id === sel);
  const selBusy =
    !!sel &&
    (sel in downloadingModels ||
      sel in verifyingModels ||
      sel in extractingModels);

  const start = async (id: string) => {
    setFailed((f) => {
      const next = { ...f };
      delete next[id];
      return next;
    });
    setPending(id);
    const ok = await downloadModel(id);
    if (!ok) setFailed((f) => ({ ...f, [id]: true }));
  };

  const languages = (m: ModelInfo) => {
    const langs = m.supported_languages;
    if (langs.length === 1) {
      try {
        return (
          new Intl.DisplayNames([i18n.language], { type: "language" }).of(
            langs[0],
          ) ?? langs[0]
        );
      } catch {
        return langs[0];
      }
    }
    return t("onboarding.speech.languages", { count: langs.length });
  };

  const row = (m: ModelInfo, i: number) => {
    const isSel = m.id === sel;
    const downloading = m.id in downloadingModels;
    const progress = downloadProgress[m.id];
    const stopped = failed[m.id] && lastProgress.current[m.id];
    return (
      <div
        key={m.id}
        className={`opt ${isSel ? "sel" : ""}`}
        role="radio"
        aria-checked={isSel}
        tabIndex={0}
        onClick={() => setSel(m.id)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") setSel(m.id);
        }}
      >
        <span className="radio" />
        <div className="body">
          <div className="name">
            {getTranslatedModelName(m, t)}
            {i === 0 && m.is_recommended && (
              <span className="badge">{t("onboarding.recommended")}</span>
            )}
          </div>
          <div className="desc">{getTranslatedModelDescription(m, t)}</div>
          <div className="meta">
            <span>
              <I icon={Globe} />
              {languages(m)}
            </span>
            {m.supports_streaming && (
              <span>
                <I icon={AudioLines} />
                {t("onboarding.speech.live")}
              </span>
            )}
            <span>
              <I icon={HardDrive} />
              {t("onboarding.mb", { mb: m.size_mb })}
            </span>
          </div>
          {downloading && (
            <div className="prog">
              <div className="bar">
                <b style={{ width: `${progress?.percentage ?? 0}%` }} />
              </div>
              <div className="line">
                <span>
                  <b>
                    {t("onboarding.ofMb", {
                      done: mb(progress?.downloaded ?? 0),
                      total: progress?.total ? mb(progress.total) : m.size_mb,
                    })}
                  </b>
                  {(() => {
                    const left = eta(
                      (progress?.total ?? 0) - (progress?.downloaded ?? 0),
                      downloadStats[m.id]?.speed,
                    );
                    return left ? ` · ${left}` : "";
                  })()}
                </span>
                <button
                  type="button"
                  className="v-btn v-ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelDownload(m.id);
                  }}
                >
                  {t("onboarding.cancel")}
                </button>
              </div>
            </div>
          )}
          {!downloading && m.id in verifyingModels && (
            <div className="prog">
              <div className="line">{t("onboarding.speech.verifying")}</div>
            </div>
          )}
          {!downloading && m.id in extractingModels && (
            <div className="prog">
              <div className="line">{t("onboarding.speech.extracting")}</div>
            </div>
          )}
          {stopped && !downloading && (
            <div className="prog">
              <div className="bar">
                <b
                  style={{
                    width: `${(100 * stopped.done) / stopped.total}%`,
                    background: "var(--danger)",
                  }}
                />
              </div>
              <div className="line">
                <span>
                  {t("onboarding.speech.stopped", {
                    done: mb(stopped.done),
                    total: mb(stopped.total),
                  })}
                </span>
                <button
                  type="button"
                  className="v-btn v-ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    start(m.id);
                  }}
                >
                  {t("onboarding.retry")}
                </button>
              </div>
            </div>
          )}
        </div>
        {m.is_downloaded && (
          <span className="side">{t("onboarding.speech.downloaded")}</span>
        )}
      </div>
    );
  };

  const moveOn = () => {
    if (sel && sel !== currentModel) setPending(sel);
    onNext();
  };

  return (
    <Frame
      screen="speech"
      step={step}
      foot={
        <>
          <BackButton onClick={onBack} />
          <span className="grow" />
          {selBusy && (
            <span className="note">{t("onboarding.speech.keepGoing")}</span>
          )}
          {selModel?.is_downloaded || selBusy ? (
            <button
              type="button"
              className="v-btn v-primary lg"
              onClick={moveOn}
            >
              {t("onboarding.continue")}
            </button>
          ) : (
            <button
              type="button"
              className="v-btn v-primary lg"
              disabled={!selModel || busyId !== null}
              onClick={() => sel && start(sel)}
            >
              <I icon={Download} />
              {t("onboarding.speech.download", {
                mb: selModel?.size_mb ?? "",
              })}
            </button>
          )}
        </>
      }
    >
      <div className="hd">
        <h1>{t("onboarding.speech.title")}</h1>
        <p>{t("onboarding.speech.description")}</p>
      </div>
      <div className="col">
        <div className={`v-group ${showAll ? "all" : ""}`} role="radiogroup">
          {featured.map(row)}
          {showAll && rest.map((m, i) => row(m, featured.length + i))}
        </div>
        {rest.length > 0 && !busyId && (
          <button
            type="button"
            className="more"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll
              ? t("onboarding.showFewerModels")
              : t("onboarding.showAllModels", {
                  total: featured.length + rest.length,
                })}
            <I
              icon={ChevronDown}
              className={showAll ? "rotate-180" : undefined}
            />
          </button>
        )}
      </div>
    </Frame>
  );
};

export default SpeechModel;
