import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { api } from "./api";
import { BackButton, Frame, I } from "./Frame";
import { StorageBlock, useStorage } from "./StorageBlock";

interface Props {
  step: number;
  onBack?: () => void;
  onFinish: () => void;
  onOpenCalls: () => void;
}

const Storage: React.FC<Props> = ({ step, onBack, onFinish, onOpenCalls }) => {
  const { t } = useTranslation();
  const storage = useStorage();
  const [finishing, setFinishing] = useState(false);
  return (
    <Frame
      screen="storage"
      step={step}
      footStyle={{ width: 640 }}
      foot={
        <>
          <BackButton onClick={onBack} />
          <span className="grow" />
          <button
            type="button"
            className="v-btn v-secondary lg"
            onClick={() =>
              api
                .revealDataFolder()
                .catch((e) => console.warn("Reveal in Finder:", e))
            }
          >
            <I icon={FolderOpen} />
            {t("storage.reveal")}
          </button>
          <button
            type="button"
            className="v-btn v-primary lg"
            disabled={finishing}
            onClick={() => {
              setFinishing(true);
              onFinish();
            }}
          >
            {t("onboarding.storage.finish")}
          </button>
        </>
      }
    >
      <div className="hd">
        <h1>{t("onboarding.storage.title")}</h1>
        <p>{t("onboarding.storage.description")}</p>
      </div>
      <StorageBlock
        usage={storage.usage}
        failed={storage.failed}
        onRetry={storage.load}
        onRemove={storage.remove}
        onOpenCalls={onOpenCalls}
      />
    </Frame>
  );
};

export default Storage;
