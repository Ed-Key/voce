import React from "react";
import ReactDOM from "react-dom/client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import VoceGlyph from "../components/icons/VoceGlyph";
import "../i18n";
import "./invitation.css";

type Offer = {
  id: number;
  app: "discord" | "face_time" | "zoom" | "google_meet";
  fictional: boolean;
};

function Invitation() {
  const { t } = useTranslation();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    const update = (value: Offer | null) => {
      if (!disposed) {
        setOffer(value);
        setExpanded(false);
        setMenu(false);
        setError(false);
        setBusy(false);
      }
    };
    const sub = listen<Offer | null>("call-invitation-changed", (event) =>
      update(event.payload),
    );
    void invoke<Offer | null>("call_invitation_snapshot")
      .then(update)
      .catch(() => update(null));
    return () => {
      disposed = true;
      void sub.then((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    if (offer)
      void invoke("layout_call_invitation", {
        height: error ? 260 : menu ? 200 : expanded ? 108 : 76,
      }).catch(() => {});
  }, [offer, expanded, menu, error]);
  async function choose(choice: "start" | "open" | "dismiss") {
    if (!offer || busy) return;
    setBusy(true);
    setError(false);
    try {
      await invoke("respond_call_invitation", { id: offer.id, choice });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !offer || busy) return;
      event.preventDefault();
      if (menu) setMenu(false);
      else if (expanded) setExpanded(false);
      else void choose("dismiss");
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [offer, busy, menu, expanded]);
  if (!offer) return null;
  return (
    <main
      className="invitation"
      data-expanded={expanded}
      aria-label={t("calls.invitation.title")}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => {
        if (!menu && !error && !document.querySelector(":focus-visible"))
          setExpanded(false);
      }}
      onFocus={() => setExpanded(true)}
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !menu &&
          !error
        )
          setExpanded(false);
      }}
    >
      {(menu || error) && (
        <div className="invitation-menu">
          {error && <p role="alert">{t("calls.invitation.failed")}</p>}
          <button disabled={busy} onClick={() => void choose("open")}>
            {t("calls.invitation.open")}
          </button>
          <button disabled={busy} onClick={() => void choose("dismiss")}>
            {t("calls.invitation.snooze")}
          </button>
        </div>
      )}
      <div className="invitation-pill">
        {expanded && (
          <button
            className="invitation-dismiss"
            disabled={busy}
            aria-label={t("calls.invitation.dismiss")}
            onClick={() => void choose("dismiss")}
          >
            <X size={14} />
          </button>
        )}
        <button
          className="invitation-trigger"
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          <span className="invitation-app" aria-hidden="true">
            <Video size={24} />
          </span>
          <span className="invitation-copy">
            <strong>{t("calls.invitation.title")}</strong>
            <span className="invitation-now">
              <i />
              {offer.fictional
                ? t("calls.invitation.demo")
                : t(`calls.apps.${offer.app}`)}
            </span>
          </span>
        </button>
        {expanded && (
          <div className="invitation-actions">
            <button
              className="invitation-start"
              disabled={busy}
              onClick={() => void choose("start")}
            >
              <span className="invitation-hand" aria-hidden="true">
                <VoceGlyph width={20} height={20} />
              </span>
              {t(busy ? "calls.invitation.starting" : "calls.start")}
            </button>
            <button
              className="invitation-options"
              disabled={busy}
              aria-label={t("calls.invitation.options")}
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <ChevronDown size={16} />
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Invitation />
  </React.StrictMode>,
);
