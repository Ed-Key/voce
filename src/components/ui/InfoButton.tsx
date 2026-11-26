import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { Tooltip } from "./Tooltip";

interface InfoButtonProps {
  children: React.ReactNode;
  size?: number;
  /** Full opacity, used next to page titles. */
  strong?: boolean;
  position?: "top" | "bottom";
}

/** The muted (i) beside a label: hover or click shows its explanation. */
export const InfoButton: React.FC<InfoButtonProps> = ({
  children,
  size = 14,
  strong = false,
  position = "top",
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <button
      type="button"
      ref={ref}
      className={`v-i ${strong ? "v-hi" : ""} ${open ? "v-open" : ""}`}
      aria-label={t("common.moreInfo")}
      aria-expanded={open}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen((value) => !value)}
    >
      <Info width={size} height={size} strokeWidth={1.6} />
      {open && (
        <Tooltip targetRef={ref} position={position}>
          {children}
        </Tooltip>
      )}
    </button>
  );
};
