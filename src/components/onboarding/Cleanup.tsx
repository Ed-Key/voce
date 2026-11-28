import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, type CleanupChoice } from "./api";
import { BackButton, Frame, type StepProps } from "./Frame";
import { CleanupOptions, LiveTest, useCleanupChooser } from "./cleanupParts";

const Cleanup: React.FC<
  StepProps & { step: number; onS1Choice?: (wanted: boolean) => void }
> = ({ step, onNext, onBack, onS1Choice }) => {
  const { t } = useTranslation();
  const c = useCleanupChooser({ onS1Choice });
  const [saving, setSaving] = useState(false);
  const { opt, test } = c;

  const finish = async (choice: CleanupChoice) => {
    setSaving(true);
    try {
      await api.saveCleanupChoice(
        choice,
        test?.status === "passed" ? test.id : 0,
      );
      onNext();
    } catch (e) {
      console.warn("Saving the cleanup choice:", e);
      toast.error(t("onboarding.cleanup.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const canContinue = test?.status === "passed" || opt === "off";

  return (
    <Frame
      screen="cleanup"
      step={step}
      footClass="wide"
      foot={
        <>
          <BackButton onClick={onBack} />
          <span className="grow" />
          {opt !== "off" &&
            (c.s1Busy ||
              test?.status === "testing" ||
              (opt === "s1" && !c.s1Down && c.s1?.state !== "ready")) && (
              <span className="note">{t("onboarding.cleanup.unlockNote")}</span>
            )}
          {!canContinue && (
            <button
              type="button"
              className="v-btn v-ghost lg"
              disabled={saving}
              onClick={() => {
                c.stopS1();
                finish({ kind: "off" });
              }}
            >
              {t("onboarding.cleanup.later")}
            </button>
          )}
          <button
            type="button"
            className="v-btn v-primary lg"
            disabled={!canContinue || saving}
            onClick={() => {
              const choice = c.choice();
              if (choice) finish(choice);
            }}
          >
            {t("onboarding.continue")}
          </button>
        </>
      }
    >
      <div className="hd">
        <h1>{t("onboarding.cleanup.title")}</h1>
        <p>{t("onboarding.cleanup.description")}</p>
      </div>
      <div className="col wide split">
        <CleanupOptions c={c} />
        <LiveTest c={c} onTurnOff={() => c.select("off")} />
      </div>
    </Frame>
  );
};

export default Cleanup;
