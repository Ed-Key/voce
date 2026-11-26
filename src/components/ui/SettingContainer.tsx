import React from "react";
import { InfoButton } from "./InfoButton";

interface SettingContainerProps {
  title: string;
  description: string;
  children: React.ReactNode;
  descriptionMode?: "inline" | "tooltip";
  /** Kept for callers; every row now sits inside a group card. */
  grouped?: boolean;
  layout?: "horizontal" | "stacked";
  disabled?: boolean;
  tooltipPosition?: "top" | "bottom";
  /** Hide the (i) button, for rows whose label says enough. */
  hideInfo?: boolean;
}

/** One setting row: name and (i) on the left, the control on the right. */
export const SettingContainer: React.FC<SettingContainerProps> = ({
  title,
  description,
  children,
  descriptionMode = "tooltip",
  layout = "horizontal",
  disabled = false,
  tooltipPosition = "top",
  hideInfo = false,
}) => {
  const inline = descriptionMode === "inline";
  const label = (
    <div className={inline ? "min-w-0" : "v-lbl"}>
      {inline ? (
        <>
          <div className="v-lbl">{title}</div>
          {description && <p className="v-meta mt-0.5">{description}</p>}
        </>
      ) : (
        <>
          <span>{title}</span>
          {!hideInfo && description && (
            <InfoButton position={tooltipPosition}>{description}</InfoButton>
          )}
        </>
      )}
    </div>
  );

  if (layout === "stacked") {
    return (
      <div className={`v-row v-stack ${disabled ? "v-off" : ""}`}>
        {label}
        <div className={inline ? "mt-2" : ""}>{children}</div>
      </div>
    );
  }

  return (
    <div
      className={`v-row ${inline ? "py-2.5" : ""} ${disabled ? "v-off" : ""}`}
    >
      {label}
      <div className="v-ctl">{children}</div>
    </div>
  );
};
