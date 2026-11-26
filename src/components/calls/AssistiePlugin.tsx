import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import "./assistie.css";

type Status = {
  running: boolean;
  phase: string;
  installation_id?: string;
  subscriptions?: number;
};
// Your ChatGPT plugin's page, set at build time (VITE_ASSISTIE_PLUGIN_URL in .env.local).
const pluginUrl = import.meta.env.VITE_ASSISTIE_PLUGIN_URL as string | undefined;
export function AssistiePlugin() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>({
    running: false,
    phase: "offline",
  });
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: number;
    const poll = async () => {
      try {
        const value = await invoke<Status>("assistie_plugin_status");
        if (!disposed) setStatus(value);
      } catch {
        if (!disposed) setStatus({ running: false, phase: "offline" });
      }
      if (!disposed) timer = window.setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, []);
  async function action(command: string, args?: Record<string, unknown>) {
    setBusy(true);
    setError(false);
    try {
      await invoke(command, args);
      setKey("");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="assistie-plugin">
      <summary>
        {t("calls.plugin.title")}{" "}
        <span>
          {t(`calls.plugin.states.${status.phase}`, {
            defaultValue: t("calls.plugin.states.offline"),
          })}
        </span>
      </summary>
      <p>{t("calls.plugin.scope")}</p>
      <div className="call-inline-actions">
        {!status.running ? (
          <button
            disabled={busy}
            onClick={() => void action("start_assistie_plugin")}
          >
            {t("calls.plugin.start")}
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={() => void action("disconnect_assistie_plugin")}
          >
            {t("calls.plugin.disconnect")}
          </button>
        )}
        {pluginUrl && (
          <button
            disabled={busy}
            onClick={() => void openUrl(pluginUrl).catch(() => setError(true))}
          >
            {t("calls.plugin.open")}
          </button>
        )}
        <button
          disabled={busy || !status.installation_id || !status.running}
          onClick={() => {
            void writeText(
              t("calls.plugin.pairingMessage", {
                installation: status.installation_id,
              }),
            )
              .then(() => setCopied(true))
              .catch(() => setError(true));
          }}
        >
          {t(copied ? "calls.plugin.copied" : "calls.plugin.copy")}
        </button>
      </div>
      <p>{t("calls.plugin.pairingHint")}</p>
      <details>
        <summary>{t("calls.plugin.credentials")}</summary>
        <p>{t("calls.plugin.keyHint")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action("configure_assistie_plugin", { key });
          }}
        >
          <label htmlFor="assistie-runtime-key">
            {t("calls.plugin.keyLabel")}
          </label>
          <input
            id="assistie-runtime-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            maxLength={512}
            disabled={busy || status.running}
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" disabled={busy || status.running || !key}>
            {t("calls.plugin.save")}
          </button>
        </form>
      </details>
      {error && <p role="alert">{t("calls.plugin.error")}</p>}
    </details>
  );
}
