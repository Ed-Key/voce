import { CallNotes } from "./calls/CallNotes";
import { MemoryPage } from "./calls/MemoryPage";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  Box,
  Cog,
  FlaskConical,
  History,
  Info,
  Sparkles,
  Cpu,
  Phone,
} from "lucide-react";
import VoceGlyph from "./icons/VoceGlyph";
import { useSettings } from "../hooks/useSettings";
import {
  GeneralSettings,
  AdvancedSettings,
  HistorySettings,
  DebugSettings,
  AboutSettings,
  PostProcessingSettings,
  ModelsSettings,
} from "./settings";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
  [key: string]: any;
}

const APP_NAME = "Voce";

interface SectionConfig {
  labelKey: string;
  icon: React.ComponentType<IconProps>;
  component: React.ComponentType;
  enabled: (settings: any) => boolean;
}

export const SECTIONS_CONFIG = {
  general: {
    labelKey: "sidebar.general",
    icon: VoceGlyph,
    component: GeneralSettings,
    enabled: () => true,
  },
  calls: {
    labelKey: "calls.sidebar",
    icon: Phone,
    component: CallNotes,
    enabled: () => true,
  },
  memory: {
    labelKey: "memory.sidebar",
    icon: Box,
    component: MemoryPage,
    enabled: () => true,
  },
  history: {
    labelKey: "sidebar.history",
    icon: History,
    component: HistorySettings,
    enabled: () => true,
  },
  models: {
    labelKey: "sidebar.models",
    icon: Cpu,
    component: ModelsSettings,
    enabled: () => true,
  },
  advanced: {
    labelKey: "sidebar.advanced",
    icon: Cog,
    component: AdvancedSettings,
    enabled: () => true,
  },
  postprocessing: {
    labelKey: "sidebar.postProcessing",
    icon: Sparkles,
    component: PostProcessingSettings,
    enabled: (settings) => settings?.post_process_enabled ?? false,
  },
  debug: {
    labelKey: "sidebar.debug",
    icon: FlaskConical,
    component: DebugSettings,
    enabled: (settings) => settings?.debug_mode ?? false,
  },
  about: {
    labelKey: "sidebar.about",
    icon: Info,
    component: AboutSettings,
    enabled: () => true,
  },
} as const satisfies Record<string, SectionConfig>;

interface SidebarProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();

  const availableSections = Object.entries(SECTIONS_CONFIG)
    .filter(([_, config]) => config.enabled(settings))
    .map(([id, config]) => ({ id: id as SidebarSection, ...config }));

  return (
    <div className="flex flex-col w-46 shrink-0 h-full px-4 pt-4">
      <div
        className="px-3 pb-3.5 text-[28px] leading-tight tracking-[-0.01em]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {APP_NAME}
      </div>
      <div className="flex flex-col w-full gap-0.5">
        {availableSections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;

          return (
            <div
              key={section.id}
              className="flex gap-2.5 items-center px-3 py-[7px] w-full rounded-lg cursor-pointer transition-colors"
              style={
                isActive
                  ? { background: "var(--raise)", color: "var(--fg)" }
                  : { color: "var(--mute)" }
              }
              onClick={() => onSectionChange(section.id)}
            >
              <Icon width={16} height={16} className="shrink-0" />
              <p
                className="text-sm font-medium truncate"
                title={t(section.labelKey)}
              >
                {t(section.labelKey)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
