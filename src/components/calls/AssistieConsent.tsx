import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { notchProfile } from "../../notch/profile";
import type { AssistieRoute } from "./AssistiePanel";

interface Props {
  callMeeting?: boolean;
  active: boolean;
  notchVisible: boolean;
  proactive: boolean;
  terra: boolean;
  canChooseRoute: boolean;
  busy: boolean;
  failed: boolean;
  onClose: () => void;
  onStop: () => void;
  onAllow: (notch: boolean, pointers: boolean, route: AssistieRoute) => void;
}

export function AssistieConsent(props: Props) {
  const { t } = useTranslation();
  const [notch, setNotch] = useState(props.active ? props.notchVisible : true);
  const [pointers, setPointers] = useState(props.active && props.proactive);
  // Terra is the fast lead route; Assistie stays available.
  const [route, setRoute] = useState<AssistieRoute>("terra");
  const terra = props.active
    ? props.terra
    : props.canChooseRoute && route === "terra";
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), []);
  return (
    <section
      className="assistie-consent"
      aria-labelledby="assistie-consent-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="assistie-consent-profile">
        <span className="terra-mark" aria-hidden="true" />
        <span>{notchProfile.displayName}</span>
        <small>
          {t(
            `calls.consent.${props.callMeeting ? "callMeetingOnly" : "meetingOnly"}`,
          )}
        </small>
      </div>
      <h3 id="assistie-consent-title" tabIndex={-1} ref={title}>
        {t(`calls.consent.${props.active ? "activeTitle" : "title"}`)}
      </h3>
      <p>
        {t(
          `calls.consent.${terra ? "terraPrivacy" : props.callMeeting ? "callPrivacy" : "privacy"}`,
        )}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.busy) props.onAllow(notch, pointers, route);
        }}
      >
        <div className="assistie-consent-options">
          {!props.active && props.canChooseRoute && (
            <fieldset disabled={props.busy}>
              <legend>{t("calls.consent.route")}</legend>
              {(["terra", "assistie"] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="assistie-route"
                    checked={route === value}
                    onChange={() => setRoute(value)}
                  />
                  <span>
                    {t(
                      `calls.consent.route${value === "terra" ? "Terra" : "Assistie"}`,
                    )}
                    <small>
                      {t(
                        `calls.consent.route${value === "terra" ? "Terra" : "Assistie"}Help`,
                      )}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <fieldset disabled={props.busy}>
            <legend>{t("calls.consent.delivery")}</legend>
            <label>
              <input
                type="checkbox"
                checked={notch}
                onChange={(event) => setNotch(event.target.checked)}
              />
              <span>
                {t("calls.consent.notch")}
                <small>{t("calls.consent.notchHelp")}</small>
              </span>
            </label>
            <label>
              <input type="checkbox" checked={false} disabled />
              <span>
                {t("calls.consent.messages")}
                <small>{t("calls.consent.messagesHelp")}</small>
              </span>
            </label>
            <label className="assistie-consent-pointers">
              <input
                type="checkbox"
                checked={pointers}
                onChange={(event) => setPointers(event.target.checked)}
              />
              <span>
                {t("calls.consent.pointers")}
                <small>{t("calls.consent.pointersHelp")}</small>
              </span>
            </label>
          </fieldset>
          <p className="assistie-consent-note">{t("calls.consent.stopHelp")}</p>
          {!notch && (
            <p className="assistie-consent-note">
              {t("calls.consent.panelHelp")}
            </p>
          )}
          {props.failed && <p role="alert">{t("calls.consent.failed")}</p>}
        </div>
        <div className="assistie-consent-actions">
          <button
            type="button"
            disabled={props.busy}
            onClick={props.active ? props.onStop : props.onClose}
          >
            {t(`calls.consent.${props.active ? "stop" : "decline"}`)}
          </button>
          <button
            type="submit"
            className="assistie-primary"
            disabled={props.busy}
          >
            {t(`calls.consent.${props.active ? "save" : "allow"}`)}
          </button>
        </div>
      </form>
    </section>
  );
}
