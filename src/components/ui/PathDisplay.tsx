import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

interface PathDisplayProps {
  path: string;
  onOpen: () => void;
  disabled?: boolean;
}

/** An Open button for a folder; the raw path stays one hover away. */
export const PathDisplay: React.FC<PathDisplayProps> = ({
  path,
  onOpen,
  disabled = false,
}) => {
  const { t } = useTranslation();

  return (
    <Button
      onClick={onOpen}
      variant="secondary"
      disabled={disabled}
      title={path}
    >
      {t("common.open")}
    </Button>
  );
};
