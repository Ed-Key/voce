import React from "react";
import { RotateCcw } from "lucide-react";

interface ResetButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
}

/** A quiet 28 px icon button; defaults to the reset arrow. */
export const ResetButton: React.FC<ResetButtonProps> = React.memo(
  ({ onClick, disabled = false, className = "", ariaLabel, children }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`v-ib ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children ?? <RotateCcw width={15} height={15} strokeWidth={1.6} />}
    </button>
  ),
);
