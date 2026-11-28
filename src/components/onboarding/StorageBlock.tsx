import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowRight, CircleAlert, LoaderCircle, Trash2 } from "lucide-react";
import {
  api,
  type StorageItem,
  type StorageKind,
  type StorageUsage,
} from "./api";
import { I, mb } from "./Frame";
import "./storage.css";

// Rows in this order, each with its swatch color (--s1 to --s7).
const ORDER: StorageKind[] = [
  "speech_model",
  "meeting_model",
  "cleanup_model",
  "runtime",
  "recordings",
  "call_data",
  "history",
];

const GB = 1_000_000_000;

export function useStorage() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setUsage(await api.getStorage());
    } catch (e) {
      console.warn("Storage usage:", e);
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const remove = useCallback(
    async (id: string) => {
      await api.removeStorageItem(id);
      await load();
    },
    [load],
  );
  return { usage, failed, load, remove };
}

/** "697 MB", "0.4 MB", "1.85 GB" (decimal units, like Finder). */
const size = (bytes: number, t: TFunction) =>
  bytes >= GB
    ? t("onboarding.gb", { gb: (bytes / GB).toFixed(2) })
    : t("onboarding.mb", { mb: mb(bytes) });

interface Props {
  usage: StorageUsage | null;
  failed: boolean;
  onRetry: () => void;
  onRemove: (id: string) => Promise<void>;
  /** Call data is deleted in Calls; its row links there. */
  onOpenCalls?: () => void;
}

/** The storage picture and list, shared by onboarding and Settings. */
export const StorageBlock: React.FC<Props> = ({
  usage,
  failed,
  onRetry,
  onRemove,
  onOpenCalls,
}) => {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirm) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !popRef.current?.contains(e.target as Node)
      )
        setConfirm(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [confirm]);

  if (!usage)
    return (
      <div className="vstore">
        <div className="store">
          {failed ? (
            <span className="wait">
              <I icon={CircleAlert} />
              {t("storage.failed")}
              <button type="button" className="v-btn v-ghost" onClick={onRetry}>
                {t("onboarding.retry")}
              </button>
            </span>
          ) : (
            <span className="wait">
              <I icon={LoaderCircle} className="spin animate-spin" />
              {t("storage.measuring")}
            </span>
          )}
        </div>
      </div>
    );

  // Kinds in the mockup's order; speech models in use first.
  const items = [...usage.items].sort(
    (a, b) =>
      ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
      Number(b.inUse) - Number(a.inUse),
  );
  const color = (kind: StorageKind) => `var(--s${ORDER.indexOf(kind) + 1})`;
  const others = Math.max(
    0,
    usage.diskTotal - usage.diskFree - usage.voceBytes,
  );
  const usedPct = usage.diskTotal ? (100 * others) / usage.diskTotal : 0;
  const fanX = (640 * usedPct) / 100;
  const share = usage.diskTotal ? (100 * usage.voceBytes) / usage.diskTotal : 0;
  const gb1 = (b: number) => (b / GB).toFixed(1);

  const detail = (i: StorageItem) => {
    switch (i.kind) {
      case "speech_model":
        return t(
          i.inUse
            ? "storage.items.speech_model.detailInUse"
            : "storage.items.speech_model.detail",
          { name: i.name },
        );
      case "recordings":
        // An unknown value shows nothing, never a key.
        return i.retention
          ? t(`storage.items.recordings.detail.${i.retention}`, {
              defaultValue: "",
            })
          : "";
      case "call_data":
      case "history":
        return t(`storage.items.${i.kind}.detail`, { count: i.count ?? 0 });
      default:
        return t(`storage.items.${i.kind}.detail`);
    }
  };

  const remove = async (id: string) => {
    setRemoving(true);
    setRemoveFailed(false);
    try {
      await onRemove(id);
      setConfirm(null);
    } catch (e) {
      console.warn("Removing storage item:", e);
      setRemoveFailed(true);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="vstore">
      <div className="store">
        <div
          className="pic"
          aria-label={t("storage.pictureLabel", {
            size: size(usage.voceBytes, t),
            disk: t("onboarding.gb", { gb: gb1(usage.diskTotal) }),
          })}
        >
          <div className="sum">
            <span className="big">
              {size(usage.voceBytes, t)}
              <small>{t("storage.share", { pct: share.toFixed(1) })}</small>
            </span>
            <span className="free">
              <b>{t("storage.free", { gb: gb1(usage.diskFree) })}</b>{" "}
              {t("storage.ofDisk", { gb: gb1(usage.diskTotal) })}
            </span>
          </div>
          <div className="disk">
            <span className="used" style={{ width: `${usedPct}%` }} />
            <span className="voce" />
          </div>
          <svg
            className="fan"
            viewBox="0 0 640 30"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={`M${fanX} 0 L${fanX + 3} 0 L640 30 L0 30 Z`} />
            <line x1={fanX} y1="0" x2="0" y2="30" />
            <line x1={fanX + 3} y1="0" x2="640" y2="30" />
          </svg>
          <div className="mix">
            {items.map((i) => (
              <i
                key={i.id}
                style={{
                  flex: i.bytes,
                  minWidth: 3,
                  background: color(i.kind),
                }}
              />
            ))}
          </div>
        </div>

        <div className="v-group list">
          {items.map((i) => (
            <div className="v-row" key={i.id}>
              <span className="sw" style={{ background: color(i.kind) }} />
              <span className="nm">
                {t(`storage.items.${i.kind}.name`)}
                <small>{detail(i)}</small>
              </span>
              <span className="sz">{size(i.bytes, t)}</span>
              <span className="ac">
                {i.kind === "call_data" ? (
                  <button
                    type="button"
                    className="v-ib"
                    title={t("storage.manageInCalls")}
                    aria-label={t("storage.manageInCalls")}
                    onClick={onOpenCalls}
                    disabled={!onOpenCalls}
                  >
                    <I icon={ArrowRight} s={15} />
                  </button>
                ) : (
                  // Nothing to remove at 0 bytes, so no trash icon.
                  i.removable &&
                  i.bytes > 0 && (
                    <button
                      type="button"
                      className="v-ib"
                      title={t(`storage.items.${i.kind}.action`)}
                      aria-label={t(`storage.items.${i.kind}.action`)}
                      onClick={() => {
                        setRemoveFailed(false);
                        setConfirm(confirm === i.id ? null : i.id);
                      }}
                    >
                      <I icon={Trash2} s={15} />
                    </button>
                  )
                )}
                {confirm === i.id && (
                  <div className="v-pop pop" ref={popRef} role="dialog">
                    <b>
                      {t(`storage.items.${i.kind}.confirmTitle`, {
                        name: i.name,
                      })}
                    </b>
                    {removeFailed
                      ? t("storage.removeFailed")
                      : t(`storage.items.${i.kind}.confirmBody`, {
                          count: i.count ?? 0,
                        })}
                    <div className="btns">
                      <button
                        type="button"
                        className="v-btn v-secondary"
                        onClick={() => setConfirm(null)}
                      >
                        {t("onboarding.cancel")}
                      </button>
                      <button
                        type="button"
                        className="v-btn v-destroy"
                        disabled={removing}
                        onClick={() => remove(i.id)}
                      >
                        {t(`storage.items.${i.kind}.confirmButton`, {
                          size: size(i.bytes, t),
                        })}
                      </button>
                    </div>
                  </div>
                )}
              </span>
            </div>
          ))}
          <div className="v-row tot">
            <span className="sw" style={{ background: "transparent" }} />
            <span className="nm">{t("storage.total")}</span>
            <span className="sz">{size(usage.voceBytes, t)}</span>
            <span className="ac" />
          </div>
        </div>
      </div>
    </div>
  );
};
