import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Eye, Lock } from "lucide-react";
import { Switch } from "../ui/ToggleSwitch";
import { api } from "./api";
import { BackButton, Frame, I, type StepProps } from "./Frame";
import { SlipMark } from "./TryIt";
import finder from "./assets/dock/finder.png";
import safari from "./assets/dock/safari.png";
import messages from "./assets/dock/messages.png";
import mail from "./assets/dock/mail.png";
import notes from "./assets/dock/notes.png";

// The film is the approved mockup's: one 14 s CSS timeline (onboarding.css,
// .vob-names). Pointer, camera and window coordinates there are desk pixels.
const Tail = () => (
  <svg className="tail" viewBox="0 0 16 17" aria-hidden="true">
    <path d="M5.5 0v9c0 3.6-1.8 6.3-5.5 7.8 4.8.7 8.7-.7 11.2-4L16 9V0Z" />
  </svg>
);

interface Props extends StepProps {
  step: number;
  /** Preview only: hold the film at this second, like the mockup's ?t=. */
  freezeAt?: number;
}

const Names: React.FC<Props> = ({ step, onNext, onBack, freezeAt }) => {
  const { t } = useTranslation();
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const d = (k: string) => t(`onboarding.names.demo.${k}`);

  useEffect(() => {
    api
      .getNamesEnabled()
      .then(setOn)
      .catch((e) => console.warn("Names setting:", e));
  }, []);

  const toggle = async (next: boolean) => {
    setOn(next);
    setBusy(true);
    try {
      await api.setNamesEnabled(next);
    } catch (e) {
      console.warn("Saving the names setting:", e);
      setOn(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame
      screen="names"
      step={step}
      className={freezeAt !== undefined ? "frozen" : ""}
      style={
        freezeAt !== undefined
          ? ({ "--t": `-${freezeAt}s` } as React.CSSProperties)
          : undefined
      }
      footStyle={{ width: 860 }}
      foot={
        <>
          <BackButton onClick={onBack} />
          <span className="grow" />
          <button type="button" className="v-btn v-primary lg" onClick={onNext}>
            {t("onboarding.continue")}
          </button>
        </>
      }
    >
      <div className="hd">
        <h1>{t("onboarding.names.title")}</h1>
        <p>{t("onboarding.names.description")}</p>
      </div>

      <div className="beats" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={`beat b${n} anim`}>
            <span className="n">{n}</span>
            {t(`onboarding.names.beats.${n}`)}
          </span>
        ))}
      </div>

      <div
        className="desk"
        role="img"
        aria-label={t("onboarding.names.filmLabel")}
      >
        <div className="cam anim">
          <div className="app anim">
            <div className="side">
              <div className="top">
                <b />
                <b />
                <b />
                <span className="flt">
                  <svg viewBox="0 0 16 16">
                    <path d="M2 4.5h12M4 8h8M6 11.5h4" />
                  </svg>
                </span>
              </div>
              <div className="search">
                <svg viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                {d("search")}
              </div>
              <div className="conv sel">
                <span className="av">{d("priyaInitials")}</span>
                <div className="tx">
                  <div className="nmrow">
                    <span className="seen y1 anim">
                      <span className="nm anim">{d("priya")}</span>
                    </span>
                    <time>{d("priyaTime")}</time>
                  </div>
                  <div className="pv">{d("priyaPreview")}</div>
                </div>
              </div>
              <div className="conv">
                <span className="av">{d("marcusInitials")}</span>
                <div className="tx">
                  <div className="nmrow">
                    <span className="seen y2 anim">
                      <span className="nm anim">{d("marcus")}</span>
                    </span>
                    <time>{d("marcusTime")}</time>
                  </div>
                  <div className="pv">{d("marcusPreview")}</div>
                </div>
              </div>
              <div className="conv new">
                <span className="av">{d("lenaInitials")}</span>
                <div className="tx">
                  <div className="nmrow">
                    <span className="seen y3 anim">{d("lena")}</span>
                    <time>{d("lenaTime")}</time>
                  </div>
                  <div className="pv">{d("lenaPreview")}</div>
                </div>
              </div>
            </div>
            <div className="scan anim" />
            <div className="chat">
              <span className="gbtn cmp">
                <svg viewBox="0 0 16 16">
                  <path d="M7.5 2.5H4.5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-3" />
                  <path d="M12.2 2.3a1.06 1.06 0 0 1 1.5 1.5L8.5 9l-2 .5.5-2Z" />
                </svg>
              </span>
              <span className="gbtn vid">
                <svg viewBox="0 0 16 16">
                  <rect x="1.5" y="4" width="9" height="8" rx="2" />
                  <path d="m10.5 7 4-2.2v6.4l-4-2.2" />
                </svg>
              </span>
              <div className="head">
                <span className="av">{d("priyaInitials")}</span>
                <span className="to">
                  {d("priya")}
                  <svg viewBox="0 0 6 8">
                    <path d="m1.5 1 3 3-3 3" />
                  </svg>
                </span>
              </div>
              <div className="stamp">
                <Trans
                  i18nKey="onboarding.names.demo.stamp"
                  components={{ b: <b /> }}
                />
              </div>
              <div className="bub out seen y1 anim">
                {d("outgoing")}
                <Tail />
              </div>
              <div className="bub seen y2 anim">
                <Trans
                  i18nKey="onboarding.names.demo.incoming"
                  components={{ nm: <span className="nm anim" /> }}
                />
                <Tail />
              </div>
              <div className="slip anim">
                <SlipMark size={18} />
                <span className="words anim">{d("spoken")}</span>
              </div>
              <div className="field">
                <span className="gbtn plus">
                  <svg viewBox="0 0 16 16">
                    <path d="M8 3.5v9M3.5 8h9" />
                  </svg>
                </span>
                <div className="input anim">
                  <svg className="wave" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M2 6.5v3M5 4v8M8 2v12M11 4.5v7M14 6.5v3" />
                  </svg>
                  <span className="wait anim">
                    <span className="caret" />
                    <span className="ph">{d("placeholder")}</span>
                  </span>
                  <span className="typed anim">
                    <Trans
                      i18nKey="onboarding.names.demo.typed"
                      components={{ hit: <span className="hit" /> }}
                    />
                    <span
                      className="caret"
                      style={{ marginLeft: 2, verticalAlign: -3 }}
                    />
                  </span>
                </div>
                <span className="gbtn emo">
                  <svg viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="6" />
                    <path d="M5.6 9.5c1.3 1.5 3.5 1.5 4.8 0" />
                    <path d="M6 6.3v.4M10 6.3v.4" />
                  </svg>
                </span>
              </div>
            </div>
          </div>

          <div className="tray anim">
            <h4>
              <I icon={Eye} />
              {t("onboarding.names.found")}
            </h4>
            <div className="chip c1 anim">
              {d("priya")}
              <I icon={Check} className="used anim" />
            </div>
            <div className="chip c2 anim">{d("marcus")}</div>
            <div className="chip c3 anim">
              {d("kubernetes")}
              <I icon={Check} className="used anim" />
            </div>
          </div>
          <div className="keys anim">
            <Trans
              i18nKey="onboarding.names.holding"
              components={{ kbd: <span className="kbd" /> }}
            />
          </div>

          {/* Real macOS app icons, exported from the system app bundles. */}
          <div className="dock" aria-hidden="true">
            <span className="ico run">
              <img src={finder} alt="" />
            </span>
            <span className="ico">
              <img src={safari} alt="" />
            </span>
            <span className="ico c anim">
              <img src={messages} alt="" />
            </span>
            <span className="ico">
              <img src={mail} alt="" />
            </span>
            <span className="ico">
              <img src={notes} alt="" />
            </span>
          </div>
          <span className="ripple at-icon anim" />
          <span className="ripple at-field anim" />
          <svg className="ptr anim" viewBox="0 0 17 23" aria-hidden="true">
            <g className="tip">
              <path
                d="M2 2v16.5l4.3-4.1 2.9 6.5 2.9-1.3-2.9-6.3h5.8Z"
                fill="#111"
                stroke="#fff"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </g>
          </svg>
        </div>
      </div>
      <div className="vs anim">
        <Trans i18nKey="onboarding.names.without" components={{ s: <s /> }} />
      </div>

      <div className="v-group set">
        <div className="v-row">
          <div className="v-lbl">
            <span>{t("onboarding.names.setting")}</span>
            <span className="sub">
              <I icon={Lock} />
              {t("onboarding.names.settingHint")}
            </span>
          </div>
          <Switch
            checked={on}
            onChange={toggle}
            disabled={busy}
            label={t("onboarding.names.setting")}
          />
        </div>
      </div>
    </Frame>
  );
};

export default Names;
