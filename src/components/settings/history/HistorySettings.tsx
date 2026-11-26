import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  Check,
  Copy,
  FolderOpen,
  RotateCcw,
  Star,
  Trash2,
  VolumeOff,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryUpdatePayload,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { dayLabel } from "@/utils/dateFormat";
import { AudioPlayer, AudioPlayerGroup } from "../../ui/AudioPlayer";
import { Button } from "../../ui/Button";
import { PageHeader } from "../../ui/PageHeader";
import { copyToClipboard } from "./clipboard";

const IconButton: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`v-ib ${active ? "v-star" : ""}`}
    title={title}
    aria-label={title}
  >
    {children}
  </button>
);

const PAGE_SIZE = 30;

/** Entries under their day ("Today", "Friday, Nov 20"), newest first. */
function byDay(
  entries: HistoryEntry[],
  t: (key: string) => string,
  locale: string,
): [string, HistoryEntry[]][] {
  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const day = dayLabel(new Date(entry.timestamp * 1000), t, locale);
    groups.set(day, [...(groups.get(day) ?? []), entry]);
  }
  return [...groups];
}

export const HistorySettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const osType = useOsType();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HistoryEntry[]>([]);
  const loadingRef = useRef(false);

  // Keep ref in sync for use in IntersectionObserver callback
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const loadPage = useCallback(async (cursor?: number) => {
    const isFirstPage = cursor === undefined;
    if (!isFirstPage && loadingRef.current) return;
    loadingRef.current = true;

    if (isFirstPage) setLoading(true);

    try {
      const result = await commands.getHistoryEntries(
        cursor ?? null,
        PAGE_SIZE,
      );
      if (result.status === "ok") {
        const { entries: newEntries, has_more } = result.data;
        setEntries((prev) =>
          isFirstPage ? newEntries : [...prev, ...newEntries],
        );
        setHasMore(has_more);
      }
    } catch (error) {
      console.error("Failed to load history entries:", error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadPage();
  }, [loadPage]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (loading) return;

    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const first = observerEntries[0];
        if (first.isIntersecting) {
          const lastEntry = entriesRef.current[entriesRef.current.length - 1];
          if (lastEntry) {
            loadPage(lastEntry.id);
          }
        }
      },
      { threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadPage]);

  // Listen for new entries added from the transcription pipeline
  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen((event) => {
      const payload: HistoryUpdatePayload = event.payload;
      if (payload.action === "added") {
        setEntries((prev) => [payload.entry, ...prev]);
      } else if (payload.action === "updated") {
        setEntries((prev) =>
          prev.map((e) => (e.id === payload.entry.id ? payload.entry : e)),
        );
      }
      // "deleted" and "toggled" are handled by optimistic updates only,
      // so we intentionally ignore them here to avoid double-mutation.
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const toggleSaved = async (id: number) => {
    // Optimistic update
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
    );
    try {
      const result = await commands.toggleHistoryEntrySaved(id);
      if (result.status !== "ok") {
        // Revert on failure
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
        );
      }
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
      // Revert on failure
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
      );
    }
  };

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const result = await commands.getAudioFilePath(fileName);
        if (result.status === "ok") {
          if (osType === "linux") {
            const fileData = await readFile(result.data);
            const blob = new Blob([fileData], { type: "audio/wav" });
            return URL.createObjectURL(blob);
          }
          return convertFileSrc(result.data, "asset");
        }
        return null;
      } catch (error) {
        console.error("Failed to get audio file path:", error);
        return null;
      }
    },
    [osType],
  );

  const deleteAudioEntry = async (id: number) => {
    // Optimistically remove
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const result = await commands.deleteHistoryEntry(id);
      if (result.status !== "ok") {
        // Reload on failure
        loadPage();
      }
    } catch (error) {
      console.error("Failed to delete entry:", error);
      loadPage();
    }
  };

  const retryHistoryEntry = async (id: number) => {
    const result = await commands.retryHistoryEntryTranscription(id);
    if (result.status !== "ok") {
      throw new Error(String(result.error));
    }
  };

  const openRecordingsFolder = async () => {
    try {
      const result = await commands.openRecordingsFolder();
      if (result.status !== "ok") {
        throw new Error(String(result.error));
      }
    } catch (error) {
      console.error("Failed to open recordings folder:", error);
    }
  };

  let content: React.ReactNode;

  if (loading) {
    content = (
      <div className="v-group">
        <p className="v-row v-meta">{t("settings.history.loading")}</p>
      </div>
    );
  } else if (entries.length === 0) {
    content = (
      <div className="v-group">
        <p className="v-row v-meta">{t("settings.history.empty")}</p>
      </div>
    );
  } else {
    content = (
      <>
        <AudioPlayerGroup>
          {byDay(entries, t, i18n.language).map(([day, dayEntries]) => (
            <section key={day}>
              <h2 className="v-gl">{day}</h2>
              <div className="v-group">
                {dayEntries.map((entry) => (
                  <HistoryEntryComponent
                    key={entry.id}
                    entry={entry}
                    onToggleSaved={() => toggleSaved(entry.id)}
                    onCopyText={() => copyToClipboard(entry.transcription_text)}
                    getAudioUrl={getAudioUrl}
                    deleteAudio={deleteAudioEntry}
                    retryTranscription={retryHistoryEntry}
                  />
                ))}
              </div>
            </section>
          ))}
        </AudioPlayerGroup>
        {/* Sentinel for infinite scroll */}
        <div ref={sentinelRef} className="h-1" />
      </>
    );
  }

  return (
    <div className="w-full">
      <PageHeader
        title={t("settings.history.title")}
        info={t("settings.history.info")}
        actions={
          <Button variant="ghost" onClick={openRecordingsFolder}>
            <FolderOpen width={15} height={15} />
            {t("settings.history.openFolder")}
          </Button>
        }
      />
      {content}
    </div>
  );
};

interface HistoryEntryProps {
  entry: HistoryEntry;
  onToggleSaved: () => void;
  onCopyText: () => Promise<boolean>;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  deleteAudio: (id: number) => Promise<void>;
  retryTranscription: (id: number) => Promise<void>;
}

const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  onToggleSaved,
  onCopyText,
  getAudioUrl,
  deleteAudio,
  retryTranscription,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // undefined while checking, null when the audio has expired.
  const [audioUrl, setAudioUrl] = useState<string | null | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  const hasTranscription = entry.transcription_text.trim().length > 0;
  const audioExpired = audioUrl === null;

  // Retention deletes old audio but keeps the text; the path lookup fails
  // for a missing file, which is how an entry learns its audio is gone.
  // ponytail: one lookup per entry on mount; a backend flag on HistoryEntry
  // would save these calls if pages ever grow far past 30 entries.
  useEffect(() => {
    let cancelled = false;
    void getAudioUrl(entry.file_name).then((url) => {
      if (!cancelled) setAudioUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [getAudioUrl, entry.file_name]);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [entry.transcription_text, expanded]);

  const handleCopyText = async () => {
    if (!hasTranscription) {
      return;
    }

    const copied = await onCopyText();
    if (!copied) {
      toast.error(t("settings.history.copyError"));
      return;
    }

    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleDeleteEntry = async () => {
    try {
      await deleteAudio(entry.id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      toast.error(t("settings.history.deleteError"));
    }
  };

  const handleRetranscribe = async () => {
    try {
      setRetrying(true);
      await retryTranscription(entry.id);
    } catch (error) {
      console.error("Failed to re-transcribe:", error);
      toast.error(t("settings.history.retranscribeError"));
    } finally {
      setRetrying(false);
    }
  };

  const toggleExpanded = () => {
    // Selecting text to copy part of it should not fold the entry.
    if (window.getSelection()?.toString()) return;
    if (clamped || expanded) setExpanded((value) => !value);
  };

  const time = new Date(entry.timestamp * 1000).toLocaleTimeString(
    i18n.language,
    { hour: "numeric", minute: "2-digit" },
  );

  return (
    <div className="px-3.5 pt-3 pb-3.5">
      <div className="flex items-center justify-between h-7 mb-1">
        <span className="v-meta">{time}</span>
        <div className="flex items-center gap-0.5 -me-1.5">
          <IconButton
            onClick={handleCopyText}
            disabled={!hasTranscription || retrying}
            title={t("settings.history.copyToClipboard")}
          >
            {showCopied ? (
              <Check width={15} height={15} strokeWidth={1.6} />
            ) : (
              <Copy width={15} height={15} strokeWidth={1.6} />
            )}
          </IconButton>
          <IconButton
            onClick={onToggleSaved}
            disabled={retrying}
            active={entry.saved}
            title={
              entry.saved
                ? t("settings.history.unsave")
                : t("settings.history.save")
            }
          >
            <Star
              width={15}
              height={15}
              strokeWidth={1.6}
              fill={entry.saved ? "currentColor" : "none"}
            />
          </IconButton>
          {!audioExpired && (
            <IconButton
              onClick={handleRetranscribe}
              disabled={retrying}
              title={t("settings.history.retranscribe")}
            >
              <RotateCcw
                width={15}
                height={15}
                strokeWidth={1.6}
                style={
                  retrying
                    ? { animation: "spin 1s linear infinite reverse" }
                    : undefined
                }
              />
            </IconButton>
          )}
          <IconButton
            onClick={handleDeleteEntry}
            disabled={retrying}
            title={t("settings.history.delete")}
          >
            <Trash2 width={15} height={15} strokeWidth={1.6} />
          </IconButton>
        </div>
      </div>

      <p
        ref={textRef}
        onClick={toggleExpanded}
        title={
          clamped && !expanded ? t("settings.history.showMore") : undefined
        }
        className={`text-sm leading-[22px] text-pretty ${
          expanded ? "" : "line-clamp-3"
        } ${clamped || expanded ? "cursor-pointer" : ""} ${
          retrying
            ? ""
            : hasTranscription
              ? "text-text select-text whitespace-pre-wrap break-words"
              : "text-text-3"
        }`}
        style={
          retrying
            ? { animation: "transcribe-pulse 3s ease-in-out infinite" }
            : undefined
        }
      >
        {retrying && (
          <style>{`
            @keyframes transcribe-pulse {
              0%, 100% { color: color-mix(in srgb, var(--color-text) 40%, transparent); }
              50% { color: color-mix(in srgb, var(--color-text) 90%, transparent); }
            }
          `}</style>
        )}
        {retrying
          ? t("settings.history.transcribing")
          : hasTranscription
            ? entry.transcription_text
            : t("settings.history.transcriptionFailed")}
      </p>

      {audioExpired ? (
        <div className="flex items-center gap-[7px] mt-3 h-6 v-meta">
          <VolumeOff width={14} height={14} strokeWidth={1.6} />
          {t("settings.history.audioExpired")}
        </div>
      ) : audioUrl ? (
        <AudioPlayer src={audioUrl} className="w-full mt-3" />
      ) : (
        <div className="mt-3 h-6" />
      )}
    </div>
  );
};
