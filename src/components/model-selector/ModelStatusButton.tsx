import React from "react";
import { ChevronsUpDown } from "lucide-react";

type ModelStatus =
  | "ready"
  | "loading"
  | "downloading"
  | "verifying"
  | "extracting"
  | "error"
  | "unloaded"
  | "none";

interface ModelStatusButtonProps {
  status: ModelStatus;
  displayText: string;
  isDropdownOpen: boolean;
  onClick: () => void;
  className?: string;
}

const statusColor: Record<ModelStatus, string> = {
  ready: "bg-accent",
  loading: "bg-accent animate-pulse",
  downloading: "bg-accent animate-pulse",
  verifying: "bg-accent animate-pulse",
  extracting: "bg-accent animate-pulse",
  error: "bg-danger",
  unloaded: "bg-track",
  none: "bg-danger",
};

/** Sidebar footer: the active model, which opens the model switcher. */
const ModelStatusButton: React.FC<ModelStatusButtonProps> = ({
  status,
  displayText,
  isDropdownOpen,
  onClick,
  className = "",
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-expanded={isDropdownOpen}
    className={`w-full flex items-center gap-1.5 text-[12.5px] leading-4 font-medium text-text-2 hover:text-text transition-colors cursor-pointer ${className}`}
    title={displayText}
  >
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor[status]}`}
    />
    <span className="truncate">{displayText}</span>
    <ChevronsUpDown
      width={13}
      height={13}
      className="ms-auto shrink-0 text-text-3"
    />
  </button>
);

export default ModelStatusButton;
