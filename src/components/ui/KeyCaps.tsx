import React from "react";

interface KeyCapsProps {
  /** A formatted combination such as "Ctrl + Option + D". */
  combo: string;
  recording?: boolean;
  onClick?: () => void;
}

/** A shortcut shown as one key cap per key. */
export const KeyCaps = React.forwardRef<HTMLDivElement, KeyCapsProps>(
  ({ combo, recording = false, onClick }, ref) => (
    <div
      ref={ref}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={`v-keys ${recording ? "v-rec" : ""}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {combo.split(" + ").map((key, i) => (
        <kbd key={i}>{key}</kbd>
      ))}
    </div>
  ),
);
KeyCaps.displayName = "KeyCaps";
