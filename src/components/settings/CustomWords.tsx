import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { X } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { InfoButton } from "../ui/InfoButton";

interface CustomWordsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

const normalizeCustomWord = (word: string) =>
  word
    .replace(/[<>"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const CustomWords: React.FC<CustomWordsProps> = React.memo(
  ({ descriptionMode = "tooltip" }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const [newWord, setNewWord] = useState("");
    const customWords = getSetting("custom_words") || [];
    const normalizedWord = normalizeCustomWord(newWord);

    const handleAddWord = () => {
      if (normalizedWord && normalizedWord.length <= 50) {
        if (customWords.includes(normalizedWord)) {
          toast.error(
            t("settings.advanced.customWords.duplicate", {
              word: normalizedWord,
            }),
          );
          return;
        }
        updateSetting("custom_words", [...customWords, normalizedWord]);
        setNewWord("");
      }
    };

    const handleRemoveWord = (wordToRemove: string) => {
      updateSetting(
        "custom_words",
        customWords.filter((word) => word !== wordToRemove),
      );
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddWord();
      }
    };

    return (
      <div className="v-row flex-wrap pt-2 pb-3 gap-y-2">
        <div className="v-lbl">
          <span>{t("settings.advanced.customWords.title")}</span>
          {descriptionMode === "tooltip" && (
            <InfoButton>
              {t("settings.advanced.customWords.description")}
            </InfoButton>
          )}
        </div>
        <div className="v-ctl">
          <Input
            type="text"
            className="w-[140px]"
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder={t("settings.advanced.customWords.placeholder")}
            disabled={isUpdating("custom_words")}
          />
          <Button
            onClick={handleAddWord}
            disabled={
              !normalizedWord ||
              normalizedWord.length > 50 ||
              isUpdating("custom_words")
            }
            variant="secondary"
          >
            {t("settings.advanced.customWords.add")}
          </Button>
        </div>
        {customWords.length > 0 && (
          <div className="w-full flex flex-wrap gap-1.5">
            {customWords.map((word) => (
              <button
                type="button"
                key={word}
                onClick={() => handleRemoveWord(word)}
                disabled={isUpdating("custom_words")}
                className="v-chip"
                aria-label={t("settings.advanced.customWords.remove", { word })}
              >
                <span>{word}</span>
                <X width={12} height={12} />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
);
