import {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { toast, Toaster } from "sonner";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { platform } from "@tauri-apps/plugin-os";
import { ModelStateEvent, RecordingErrorEvent } from "./lib/types/events";
import "./App.css";
import AccessibilityPermissions from "./components/AccessibilityPermissions";
import SecureInputWarning from "./components/SecureInputWarning";
import Onboarding from "./components/onboarding";
import {
  api as onboardingApi,
  setPreviewMode,
  STEPS,
  type OnboardingStep,
} from "./components/onboarding/api";
import {
  DebugSettings,
  StorageSettings,
  type OnboardingPreviewStep,
} from "./components/settings";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar, SidebarSection, SECTIONS_CONFIG } from "./components/Sidebar";
import { WhatsNewGate } from "./components/whats-new";
import { useSettings } from "./hooks/useSettings";
import { useSettingsStore } from "./stores/settingsStore";
import { commands } from "@/bindings";
import { getLanguageDirection, initializeRTL } from "@/lib/utils/rtl";

/** Where onboarding opens: the saved step, after Permissions when a
 *  permission was revoked since. */
type OnboardingStart = { start: OnboardingStep; regrant: boolean };

// Call pages and Memory keep their own wide layouts; every other page uses
// the shared 680 px column.
const FULL_WIDTH_SECTIONS = new Set<SidebarSection>(["calls", "memory"]);

const renderSettingsContent = (
  section: SidebarSection,
  onPreviewOnboarding: (step: OnboardingPreviewStep) => void,
  onSectionChange: (section: SidebarSection) => void,
) => {
  if (section === "debug") {
    return <DebugSettings onPreviewOnboarding={onPreviewOnboarding} />;
  }
  if (section === "storage") {
    return <StorageSettings onOpenCalls={() => onSectionChange("calls")} />;
  }

  const ActiveComponent =
    SECTIONS_CONFIG[section]?.component || SECTIONS_CONFIG.general.component;
  return <ActiveComponent />;
};

function App() {
  const { t, i18n } = useTranslation();
  // null while checking; "done" shows the main window.
  const [onboarding, setOnboarding] = useState<OnboardingStart | "done" | null>(
    null,
  );
  const [onboardingPreview, setOnboardingPreview] =
    useState<OnboardingPreviewStep | null>(null);
  const [currentSection, setCurrentSection] =
    useState<SidebarSection>("general");
  const { settings, updateSetting, refreshSettings } = useSettings();
  const direction = getLanguageDirection(i18n.language);
  const refreshAudioDevices = useSettingsStore(
    (state) => state.refreshAudioDevices,
  );
  const refreshOutputDevices = useSettingsStore(
    (state) => state.refreshOutputDevices,
  );
  const hasCompletedPostOnboardingInit = useRef(false);
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const isShowingOnboarding =
    onboardingPreview !== null ||
    (onboarding !== null && onboarding !== "done");

  // Classic scrollbars consume layout space. Reserve a matching gutter on the
  // opposite edge while onboarding is visible so its content stays centered in
  // the physical window. Overlay scrollbars ignore scrollbar-gutter.
  useLayoutEffect(() => {
    const attribute = "data-onboarding-active";
    document.documentElement.toggleAttribute(attribute, isShowingOnboarding);
    return () => document.documentElement.removeAttribute(attribute);
  }, [isShowingOnboarding]);

  // The debug preview runs the real screens against an inert backend.
  useEffect(() => {
    setPreviewMode(onboardingPreview !== null);
    return () => setPreviewMode(false);
  }, [onboardingPreview]);

  // Reset the scroll position whenever the active section changes.
  useLayoutEffect(() => {
    settingsScrollRef.current?.scrollTo({ top: 0 });
  }, [currentSection]);

  useEffect(() => {
    checkOnboardingStatus();
  }, []);

  // Initialize RTL direction when language changes
  useEffect(() => {
    initializeRTL(i18n.language);
  }, [i18n.language]);

  // Initialize Enigo, shortcuts, and refresh audio devices when main app loads
  useEffect(() => {
    if (onboarding === "done" && !hasCompletedPostOnboardingInit.current) {
      hasCompletedPostOnboardingInit.current = true;
      Promise.all([
        commands.initializeEnigo(),
        commands.initializeShortcuts(),
      ]).catch((e) => {
        console.warn("Failed to initialize:", e);
      });
      refreshAudioDevices();
      refreshOutputDevices();
    }
  }, [onboarding, refreshAudioDevices, refreshOutputDevices]);

  // Handle keyboard shortcuts for debug mode toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS)
      const isDebugShortcut =
        event.shiftKey &&
        event.key.toLowerCase() === "d" &&
        (event.ctrlKey || event.metaKey);

      if (isDebugShortcut) {
        event.preventDefault();
        const currentDebugMode = settings?.debug_mode ?? false;
        updateSetting("debug_mode", !currentDebugMode);
      }
    };

    // Add event listener when component mounts
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup event listener when component unmounts
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settings?.debug_mode, updateSetting]);

  // Listen for recording errors from the backend and show a toast
  useEffect(() => {
    const subscription = listen("call-invitation-open", () =>
      setCurrentSection("calls"),
    );
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<RecordingErrorEvent>("recording-error", (event) => {
      const { error_type, detail } = event.payload;

      if (error_type === "microphone_permission_denied") {
        const currentPlatform = platform();
        const platformKey = `errors.micPermissionDenied.${currentPlatform}`;
        const description = t(platformKey, {
          defaultValue: t("errors.micPermissionDenied.generic"),
        });
        toast.error(t("errors.micPermissionDeniedTitle"), { description });
      } else if (error_type === "no_input_device") {
        toast.error(t("errors.noInputDeviceTitle"), {
          description: t("errors.noInputDevice"),
        });
      } else {
        toast.error(
          t("errors.recordingFailed", { error: detail ?? "Unknown error" }),
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for paste failures and show a toast.
  // The technical error detail is logged to handy.log on the Rust side
  // (see actions.rs `error!("Failed to paste transcription: ...")`),
  // so we show a localized, user-friendly message here instead of the raw error.
  useEffect(() => {
    const unlisten = listen("paste-error", () => {
      toast.error(t("errors.pasteFailedTitle"), {
        description: t("errors.pasteFailed"),
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for transcription failures and show a toast.
  // The payload is the backend error message (also logged to handy.log).
  useEffect(() => {
    const unlisten = listen<string>("transcription-error", (event) => {
      toast.error(t("errors.transcriptionFailedTitle"), {
        description: event.payload,
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for model loading failures and show a toast
  useEffect(() => {
    const unlisten = listen<ModelStateEvent>("model-state-changed", (event) => {
      if (event.payload.event_type === "loading_failed") {
        toast.error(
          t("errors.modelLoadFailed", {
            model:
              event.payload.model_name || t("errors.modelLoadFailedUnknown"),
          }),
          {
            description: event.payload.error,
          },
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  const revealMainWindowForPermissions = async () => {
    try {
      await commands.showMainWindowCommand();
    } catch (e) {
      console.warn("Failed to show main window for permission onboarding:", e);
    }
  };

  const checkOnboardingStatus = async () => {
    let start: OnboardingStep;
    try {
      start = await onboardingApi.getStep();
    } catch (error) {
      console.error("Failed to read the onboarding step:", error);
      start = "welcome";
    }
    // Past Permissions, a revoked permission sends the user back there first,
    // then to the saved step (or the main window).
    if (STEPS.indexOf(start) > STEPS.indexOf("permissions")) {
      try {
        const granted = await onboardingApi.checkPermissions();
        if (!granted.microphone || !granted.accessibility) {
          await revealMainWindowForPermissions();
          setOnboarding({ start, regrant: true });
          return;
        }
      } catch (e) {
        // If we can't check, proceed and let the user fix it in the app.
        console.warn("Failed to check permissions:", e);
      }
    }
    setOnboarding(start === "done" ? "done" : { start, regrant: false });
  };

  const handleOnboardingDone = useCallback(
    (openSection?: "calls") => {
      if (openSection) setCurrentSection(openSection);
      // Onboarding saved settings through its own commands; reload them.
      refreshSettings();
      setOnboarding("done");
    },
    [refreshSettings],
  );

  const handlePreviewDone = useCallback(() => setOnboardingPreview(null), []);

  // Rendered once around every step below (including onboarding) so
  // toast.error() calls surface to the user. sonner renders via a portal, so
  // its position in the tree doesn't affect layout. Without this, errors during
  // onboarding (e.g. a model download failing because blob.handy.computer is
  // unreachable) are silently swallowed and the wizard just appears to "blink".
  const toaster = (
    <Toaster
      theme="system"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "bg-background border border-mid-gray/20 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 text-sm",
          title: "font-medium",
          description: "text-mid-gray",
          actionButton:
            "px-2 py-1 text-xs font-medium rounded-lg border bg-mid-gray/10 border-mid-gray/20 hover:bg-background-ui/30 hover:border-logo-primary cursor-pointer whitespace-nowrap",
        },
      }}
    />
  );

  // Still checking onboarding status
  if (onboarding === null) {
    return null;
  }

  // Select the content for the current step. The Toaster is rendered once, in a
  // stable wrapper around this node, so crossing between onboarding steps and
  // the main app never remounts it (which would drop any in-flight toast).
  let content: ReactNode;
  if (onboardingPreview) {
    // Render previews in the same top-level slot as real onboarding. Keeping
    // the settings layout unmounted ensures viewport overflow behaves exactly
    // as it does during first-run onboarding.
    content = (
      <>
        <Onboarding
          key={onboardingPreview}
          start={onboardingPreview}
          onDone={handlePreviewDone}
          preview
        />
        <button
          type="button"
          onClick={() => setOnboardingPreview(null)}
          className="fixed top-4 end-4 z-50 v-btn v-secondary"
        >
          {t("settings.debug.onboardingPreview.exitButton")}
        </button>
      </>
    );
  } else if (onboarding !== "done") {
    content = (
      <Onboarding
        start={onboarding.start}
        regrant={onboarding.regrant}
        onDone={handleOnboardingDone}
      />
    );
  } else {
    content = (
      <div
        dir={direction}
        className="h-screen flex select-none cursor-default bg-background"
      >
        <ErrorBoundary context="What's New">
          <WhatsNewGate />
        </ErrorBoundary>
        <Sidebar
          activeSection={currentSection}
          onSectionChange={setCurrentSection}
        />
        <div className="flex-1 min-w-0 flex flex-col">
          {/* The window's top edge drags across its full width (the sidebar
              has its own strip). Pages scroll below it, never underneath. */}
          <div data-tauri-drag-region className="h-10 shrink-0" />
          <main
            ref={settingsScrollRef}
            className={`flex-1 min-h-0 overflow-y-auto ${FULL_WIDTH_SECTIONS.has(currentSection) ? "" : "v-fade"}`}
          >
            {FULL_WIDTH_SECTIONS.has(currentSection) ? (
              <div className="flex flex-col items-center px-4 pb-4 gap-4 min-h-full">
                <AccessibilityPermissions />
                <SecureInputWarning />
                {renderSettingsContent(
                  currentSection,
                  setOnboardingPreview,
                  setCurrentSection,
                )}
              </div>
            ) : (
              <div className="v-col min-h-full">
                <div className="flex flex-col gap-4 empty:hidden mb-6">
                  <AccessibilityPermissions />
                  <SecureInputWarning />
                </div>
                {renderSettingsContent(
                  currentSection,
                  setOnboardingPreview,
                  setCurrentSection,
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    );
  }

  // Onboarding draws its own full window (drag strip included).
  return (
    <>
      {toaster}
      {content}
    </>
  );
}

export default App;
