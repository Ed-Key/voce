// Terra (the meeting companion) is experimental: every Terra page, tab, control and saved reply shows only while
// Settings > Advanced > Experimental features is on. The backend refuses Terra commands while it is off.
export const TABS = ["notes", "transcript", "system", "terra"] as const;
export type Tab = (typeof TABS)[number];

export const terraOn = (settings?: { experimental_enabled?: boolean } | null) =>
  settings?.experimental_enabled ?? false;

// The System view is Terra's pipeline diagram (agent, notch, brief), so it goes with Terra.
const TERRA_TABS: readonly Tab[] = ["system", "terra"];

export const visibleTabs = (on: boolean): readonly Tab[] =>
  on ? TABS : TABS.filter((tab) => !TERRA_TABS.includes(tab));

// A page left on a Terra tab falls back to Notes when the switch goes off.
export const tabAfterSwitch = (tab: Tab, on: boolean): Tab =>
  !on && TERRA_TABS.includes(tab) ? "notes" : tab;
