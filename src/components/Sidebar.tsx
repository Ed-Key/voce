import { CallNotes } from "./calls/CallNotes";
import { MemoryPage } from "./calls/MemoryPage";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  Box,
  Cog,
  FlaskConical,
  HardDrive,
  History,
  Info,
  Sparkles,
  Cpu,
  Phone,
  SlidersHorizontal,
} from "lucide-react";
import VoceWordmark from "./icons/VoceWordmark";
import ModelSelector from "./model-selector";
import UpdateChecker from "./update-checker";
import { useSettings } from "../hooks/useSettings";
import { terraOn } from "./calls/terraGate";
import {
  GeneralSettings,
  AdvancedSettings,
  HistorySettings,
  DebugSettings,
  AboutSettings,
  ModelsSettings,
  StorageSettings,
  CleanupSettings,
} from "./settings";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
  [key: string]: any;
}

interface SectionConfig {
  labelKey: string;
  icon: React.ComponentType<IconProps>;
  component: React.ComponentType;
  enabled: (settings: any) => boolean;
  /** Nav block: 0 content, 1 settings, 2 about. A gap separates blocks. */
  block: 0 | 1 | 2;
}

// Content first, then settings, then About.
export const SECTIONS_CONFIG = {
  calls: {
    labelKey: "calls.sidebar",
    icon: Phone,
    component: CallNotes,
    enabled: () => true,
    block: 0,
  },
  memory: {
    labelKey: "memory.sidebar",
    icon: Box,
    component: MemoryPage,
    // Terra's memory: experimental, like the rest of Terra.
    enabled: (settings) => terraOn(settings),
    block: 0,
  },
  history: {
    labelKey: "sidebar.history",
    icon: History,
    component: HistorySettings,
    enabled: () => true,
    block: 0,
  },
  general: {
    labelKey: "sidebar.general",
    icon: SlidersHorizontal,
    component: GeneralSettings,
    enabled: () => true,
    block: 1,
  },
  models: {
    labelKey: "sidebar.models",
    icon: Cpu,
    component: ModelsSettings,
    enabled: () => true,
    block: 1,
  },
  cleanup: {
    labelKey: "sidebar.cleanup",
    icon: Sparkles,
    component: CleanupSettings,
    enabled: () => true,
    block: 1,
  },
  storage: {
    labelKey: "sidebar.storage",
    icon: HardDrive,
    component: StorageSettings,
    enabled: () => true,
    block: 1,
  },
  advanced: {
    labelKey: "sidebar.advanced",
    icon: Cog,
    component: AdvancedSettings,
    enabled: () => true,
    block: 1,
  },
  debug: {
    labelKey: "sidebar.debug",
    icon: FlaskConical,
    component: DebugSettings,
    enabled: (settings) => settings?.debug_mode ?? false,
    block: 1,
  },
  about: {
    labelKey: "sidebar.about",
    icon: Info,
    component: AboutSettings,
    enabled: () => true,
    block: 2,
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
    <aside className="flex flex-col w-[196px] shrink-0 h-full px-2.5 pb-3.5 bg-bg-side border-e border-line">
      {/* Hidden title bar: the traffic lights sit in this strip, and it drags the window. */}
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div data-tauri-drag-region className="px-1.5 pt-2 pb-5">
        <VoceWordmark width={84} />
      </div>
      <nav className="flex flex-col">
        {availableSections.map((section, i) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          const newBlock =
            i > 0 && availableSections[i - 1].block !== section.block;

          return (
            <button
              type="button"
              key={section.id}
              data-section={section.id}
              aria-current={isActive ? "page" : undefined}
              className={`flex gap-2.5 items-center h-8 px-2 w-full rounded-lg cursor-pointer transition-colors text-[13.5px] leading-[18px] font-medium text-start ${
                newBlock ? "mt-3.5" : ""
              } ${
                isActive
                  ? "bg-hover text-text"
                  : "text-text-2 hover:text-text hover:bg-hover/60"
              }`}
              onClick={() => onSectionChange(section.id)}
            >
              <Icon
                width={16}
                height={16}
                strokeWidth={1.6}
                className={`shrink-0 ${isActive ? "text-accent" : ""}`}
              />
              <span className="truncate" title={t(section.labelKey)}>
                {t(section.labelKey)}
              </span>
            </button>
          );
        })}
      </nav>
      <div className="mt-auto ps-2 -me-2 flex flex-col gap-2">
        <UpdateChecker />
        <div>
          <div className="v-gl m-0 mb-1">{t("sidebar.model")}</div>
          <ModelSelector />
        </div>
      </div>
    </aside>
  );
};
