import React, { useCallback, useEffect, useRef, useState } from "react";
import { useModelStore } from "@/stores/modelStore";
import { api, STEPS, type OnboardingStep } from "./api";
import Welcome from "./Welcome";
import Permissions from "./Permissions";
import SpeechModel from "./SpeechModel";
import Cleanup from "./Cleanup";
import TryIt from "./TryIt";
import Names from "./Names";
import Storage from "./Storage";
import "./onboarding.css";

export type { OnboardingStep };

interface OnboardingProps {
  /** The saved step to resume at. */
  start: OnboardingStep;
  /** A permission was revoked: show Permissions first, then go back to
   *  `start` (table rows 4 and 4b). */
  regrant?: boolean;
  onDone: (openSection?: "calls") => void;
  /** Debug preview: never switches the active speech model. */
  preview?: boolean;
}

const Onboarding: React.FC<OnboardingProps> = ({
  start,
  regrant,
  onDone,
  preview,
}) => {
  const [step, setStep] = useState<OnboardingStep>(
    regrant ? "permissions" : start,
  );
  const [regranting, setRegranting] = useState(!!regrant);

  const prevOf = (s: OnboardingStep) => STEPS[STEPS.indexOf(s) - 1];

  // Save that a step is done before showing the next one, so a quit right
  // after a step completes reopens the next one (row 2b). The backend never
  // moves the saved step back; the screen follows the order here, so going
  // Back and forward again walks through each step.
  const complete = useCallback(
    async (done: OnboardingStep, openSection?: "calls") => {
      try {
        await api.completeStep(done);
      } catch (e) {
        console.warn("Saving the onboarding step:", e);
      }
      const next = STEPS[STEPS.indexOf(done) + 1];
      if (next === "done") onDone(openSection);
      else setStep(next);
    },
    [onDone],
  );
  const forward = () => complete(step);
  const back = () => setStep(prevOf(step));

  // ---- the speech model the user moved on with (rows 9, 9b) ----
  const {
    models,
    currentModel,
    downloadingModels,
    verifyingModels,
    extractingModels,
    selectModel,
    downloadModel,
  } = useModelStore();
  const [pending, setPendingState] = useState<string | null>(null);
  const [modelError, setModelError] = useState(false);
  const selecting = useRef(false);

  useEffect(() => {
    api
      .getPendingModel()
      .then((id) => id && setPendingState(id))
      .catch((e) => console.warn("Pending model:", e));
  }, []);

  // A speech download stopped by a quit resumes from its partial file,
  // whichever step the user relaunches at (rows 8 and 9).
  const resumed = useRef(false);
  useEffect(() => {
    if (preview || resumed.current || !pending || models.length === 0) return;
    resumed.current = true;
    const m = models.find((x) => x.id === pending);
    if (m && !m.is_downloaded && !(pending in downloadingModels))
      downloadModel(pending);
  }, [preview, pending, models, downloadingModels, downloadModel]);

  const setPending = useCallback((id: string | null) => {
    setPendingState(id);
    setModelError(false);
    api.setPendingModel(id).catch((e) => console.warn("Pending model:", e));
  }, []);

  useEffect(() => {
    if (preview || !pending || modelError || selecting.current) return;
    if (pending === currentModel) {
      setPending(null);
      return;
    }
    const model = models.find((m) => m.id === pending);
    const busy =
      pending in downloadingModels ||
      pending in verifyingModels ||
      pending in extractingModels;
    if (!model?.is_downloaded || busy) return;
    selecting.current = true;
    selectModel(pending).then((ok) => {
      selecting.current = false;
      if (ok) setPending(null);
      else setModelError(true);
    });
  }, [
    preview,
    pending,
    modelError,
    currentModel,
    models,
    downloadingModels,
    verifyingModels,
    extractingModels,
    selectModel,
    setPending,
  ]);

  // Voce cleanup is the recommended default, so its model downloads in the
  // background from the Speech step on, ready (and warmed) by Cleanup. The
  // controller owns the intent: picking anything else anywhere rejects it
  // and voids a start check still reading status (review 4, finding 3).
  // Without a pick this session, the saved choice decides: before the
  // Cleanup step unless another cleanup is saved, after it only Voce cleanup.
  const s1Intent = useRef<"auto" | "wanted" | "rejected">("auto");
  const s1Check = useRef(0);
  const s1Started = useRef(false);
  const onS1Choice = useCallback((wanted: boolean) => {
    s1Intent.current = wanted ? "wanted" : "rejected";
    s1Check.current++;
  }, []);
  useEffect(() => {
    if (preview || step !== "speech" || s1Started.current) return;
    if (s1Intent.current === "rejected") return;
    s1Started.current = true;
    const check = ++s1Check.current;
    (async () => {
      const [saved, choice, s1] = await Promise.all([
        api.getStep(),
        api.savedCleanup(),
        api.getS1Status(),
      ]);
      if (check !== s1Check.current || s1Intent.current === "rejected") return;
      const cleanupDone = STEPS.indexOf(saved) > STEPS.indexOf("cleanup");
      const wanted =
        s1Intent.current === "wanted" ||
        (cleanupDone ? choice === "s1" : choice !== "other");
      if (wanted && s1.state === "missing") await api.downloadS1();
    })().catch((e) => console.warn("Voce cleanup download:", e));
  }, [preview, step]);

  useEffect(() => {
    if (step === "done") onDone();
  }, [step, onDone]);

  const meter = STEPS.indexOf(step);

  switch (step) {
    case "welcome":
      return <Welcome onNext={forward} />;
    case "permissions":
      return (
        <Permissions
          step={meter}
          onBack={regranting ? undefined : back}
          onNext={() => {
            if (!regranting) return forward();
            // Back to where the user was, not to the start of setup.
            setRegranting(false);
            api
              .completeStep("permissions")
              .catch((e) => console.warn("Saving the onboarding step:", e));
            if (start === "done") onDone();
            else setStep(start);
          }}
        />
      );
    case "speech":
      return (
        <SpeechModel
          step={meter}
          onBack={back}
          onNext={forward}
          pending={pending}
          setPending={setPending}
        />
      );
    case "cleanup":
      return (
        <Cleanup
          step={meter}
          onBack={back}
          onNext={forward}
          onS1Choice={onS1Choice}
        />
      );
    case "try":
      return (
        <TryIt
          step={meter}
          onBack={back}
          onNext={forward}
          pending={pending}
          modelError={modelError}
          onRetryModel={() => setModelError(false)}
          onPickModel={() => setStep("speech")}
        />
      );
    case "names":
      return <Names step={meter} onBack={back} onNext={forward} />;
    case "storage":
      return (
        <Storage
          step={meter}
          onBack={back}
          onFinish={() => complete("storage")}
          onOpenCalls={() => complete("storage", "calls")}
        />
      );
    default:
      return null;
  }
};

export default Onboarding;
