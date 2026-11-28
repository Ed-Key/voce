import React from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { api } from "@/components/onboarding/api";
import { I } from "@/components/onboarding/Frame";
import { PageHeader } from "../../ui/PageHeader";
import { StorageBlock, useStorage } from "@/components/onboarding/StorageBlock";

/** Settings > Storage: the same block as the last onboarding step. */
export const StorageSettings: React.FC<{ onOpenCalls?: () => void }> = ({
  onOpenCalls,
}) => {
  const { t } = useTranslation();
  const storage = useStorage();
  return (
    <>
      <PageHeader
        title={t("storage.title")}
        actions={
          <button
            type="button"
            className="v-btn v-secondary"
            onClick={() =>
              api
                .revealDataFolder()
                .catch((e) => console.warn("Reveal in Finder:", e))
            }
          >
            <I icon={FolderOpen} />
            {t("storage.reveal")}
          </button>
        }
      />
      <StorageBlock
        usage={storage.usage}
        failed={storage.failed}
        onRetry={storage.load}
        onRemove={storage.remove}
        onOpenCalls={onOpenCalls}
      />
    </>
  );
};
