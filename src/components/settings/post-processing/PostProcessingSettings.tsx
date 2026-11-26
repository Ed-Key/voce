import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Plus, RefreshCw } from "lucide-react";
import { commands } from "@/bindings";

import { Alert } from "../../ui/Alert";
import {
  Dropdown,
  SettingContainer,
  SettingsGroup,
  Textarea,
} from "@/components/ui";
import { Button } from "../../ui/Button";
import { ResetButton } from "../../ui/ResetButton";
import { Input } from "../../ui/Input";
import { InfoButton } from "../../ui/InfoButton";
import { PageHeader } from "../../ui/PageHeader";

import { ProviderSelect } from "../PostProcessingSettingsApi/ProviderSelect";
import { BaseUrlField } from "../PostProcessingSettingsApi/BaseUrlField";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import { usePostProcessProviderState } from "../PostProcessingSettingsApi/usePostProcessProviderState";
import { ShortcutInput } from "../ShortcutInput";
import { useSettings } from "../../../hooks/useSettings";

// Provider, Base URL, API Key and Model share one width and one right edge.
const FIELD_WIDTH = "w-[260px]";

const PostProcessingSettingsApiComponent: React.FC = () => {
  const { t } = useTranslation();
  const state = usePostProcessProviderState();

  return (
    <>
      <SettingContainer
        title={t("settings.postProcessing.api.provider.title")}
        description={t("settings.postProcessing.api.provider.description")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <ProviderSelect
          options={state.providerOptions}
          value={state.selectedProviderId}
          onChange={state.handleProviderSelect}
        />
      </SettingContainer>

      {state.isAppleProvider ? (
        state.appleIntelligenceUnavailable ? (
          <Alert variant="error" contained>
            {t("settings.postProcessing.api.appleIntelligence.unavailable")}
          </Alert>
        ) : null
      ) : (
        <>
          {state.selectedProvider?.id === "custom" && (
            <SettingContainer
              title={t("settings.postProcessing.api.baseUrl.title")}
              description={t("settings.postProcessing.api.baseUrl.description")}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              <BaseUrlField
                value={state.baseUrl}
                onBlur={state.handleBaseUrlChange}
                placeholder={t(
                  "settings.postProcessing.api.baseUrl.placeholder",
                )}
                disabled={state.isBaseUrlUpdating}
                className={FIELD_WIDTH}
              />
            </SettingContainer>
          )}

          <SettingContainer
            title={t("settings.postProcessing.api.apiKey.title")}
            description={t("settings.postProcessing.api.apiKey.description")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <ApiKeyField
              value={state.apiKey}
              onBlur={state.handleApiKeyChange}
              placeholder={t("settings.postProcessing.api.apiKey.placeholder")}
              disabled={state.isApiKeyUpdating}
              className={FIELD_WIDTH}
            />
          </SettingContainer>
        </>
      )}

      {!state.isAppleProvider && (
        <SettingContainer
          title={t("settings.postProcessing.api.model.title")}
          description={
            state.isCustomProvider
              ? t("settings.postProcessing.api.model.descriptionCustom")
              : t("settings.postProcessing.api.model.descriptionDefault")
          }
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <ResetButton
            onClick={state.handleRefreshModels}
            disabled={state.isFetchingModels}
            ariaLabel={t("settings.postProcessing.api.model.refreshModels")}
          >
            <RefreshCw
              width={15}
              height={15}
              strokeWidth={1.6}
              className={state.isFetchingModels ? "animate-spin" : ""}
            />
          </ResetButton>
          <ModelSelect
            value={state.model}
            options={state.modelOptions}
            disabled={state.isModelUpdating}
            isLoading={state.isFetchingModels}
            placeholder={
              state.modelOptions.length > 0
                ? t("settings.postProcessing.api.model.placeholderWithOptions")
                : t("settings.postProcessing.api.model.placeholderNoOptions")
            }
            onSelect={state.handleModelSelect}
            onCreate={state.handleModelCreate}
            onBlur={() => {}}
            className={FIELD_WIDTH}
          />
        </SettingContainer>
      )}
    </>
  );
};

const PostProcessingSettingsPromptsComponent: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");

  const prompts = getSetting("post_process_prompts") || [];
  const selectedPromptId = getSetting("post_process_selected_prompt_id") || "";
  const selectedPrompt =
    prompts.find((prompt) => prompt.id === selectedPromptId) || null;

  useEffect(() => {
    if (isCreating) return;

    if (selectedPrompt) {
      setDraftName(selectedPrompt.name);
      setDraftText(selectedPrompt.prompt);
    } else {
      setDraftName("");
      setDraftText("");
    }
  }, [
    isCreating,
    selectedPromptId,
    selectedPrompt?.name,
    selectedPrompt?.prompt,
  ]);

  const handlePromptSelect = (promptId: string | null) => {
    if (!promptId) return;
    updateSetting("post_process_selected_prompt_id", promptId);
    setIsCreating(false);
  };

  const handleCreatePrompt = async () => {
    if (!draftName.trim() || !draftText.trim()) return;

    try {
      const result = await commands.addPostProcessPrompt(
        draftName.trim(),
        draftText.trim(),
      );
      if (result.status === "ok") {
        await refreshSettings();
        updateSetting("post_process_selected_prompt_id", result.data.id);
        setIsCreating(false);
      }
    } catch (error) {
      console.error("Failed to create prompt:", error);
    }
  };

  const handleUpdatePrompt = async () => {
    if (!selectedPromptId || !draftName.trim() || !draftText.trim()) return;

    try {
      await commands.updatePostProcessPrompt(
        selectedPromptId,
        draftName.trim(),
        draftText.trim(),
      );
      await refreshSettings();
    } catch (error) {
      console.error("Failed to update prompt:", error);
    }
  };

  const handleDeletePrompt = async (promptId: string) => {
    if (!promptId) return;

    try {
      await commands.deletePostProcessPrompt(promptId);
      await refreshSettings();
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to delete prompt:", error);
    }
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    if (selectedPrompt) {
      setDraftName(selectedPrompt.name);
      setDraftText(selectedPrompt.prompt);
    } else {
      setDraftName("");
      setDraftText("");
    }
  };

  const handleStartCreate = () => {
    setIsCreating(true);
    setDraftName("");
    setDraftText("");
  };

  const hasPrompts = prompts.length > 0;
  const isDirty =
    !!selectedPrompt &&
    (draftName.trim() !== selectedPrompt.name ||
      draftText.trim() !== selectedPrompt.prompt.trim());
  const editing = isCreating || (hasPrompts && !!selectedPrompt);

  return (
    <>
      <SettingContainer
        title={t("settings.postProcessing.prompts.selectedPrompt.title")}
        description={t(
          "settings.postProcessing.prompts.selectedPrompt.description",
        )}
        descriptionMode="tooltip"
        grouped={true}
      >
        <ResetButton
          onClick={handleStartCreate}
          disabled={isCreating}
          ariaLabel={t("settings.postProcessing.prompts.createNew")}
        >
          <Plus width={16} height={16} strokeWidth={1.6} />
        </ResetButton>
        <Dropdown
          selectedValue={selectedPromptId || null}
          options={prompts.map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          onSelect={(value) => handlePromptSelect(value)}
          placeholder={
            prompts.length === 0
              ? t("settings.postProcessing.prompts.noPrompts")
              : t("settings.postProcessing.prompts.selectPrompt")
          }
          disabled={isUpdating("post_process_selected_prompt_id") || isCreating}
          width={260}
        />
      </SettingContainer>

      {editing && (
        <>
          <div className="v-row v-stack">
            <label className="v-lbl" htmlFor="prompt-label">
              {t("settings.postProcessing.prompts.promptLabel")}
            </label>
            <Input
              id="prompt-label"
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder={t(
                "settings.postProcessing.prompts.promptLabelPlaceholder",
              )}
              className="w-full"
            />
          </div>
          <div className="v-row v-stack">
            <div className="v-lbl">
              <label htmlFor="prompt-text">
                {t("settings.postProcessing.prompts.promptInstructions")}
              </label>
              <InfoButton>
                <Trans
                  i18nKey="settings.postProcessing.prompts.promptTip"
                  components={{ code: <code /> }}
                />
              </InfoButton>
            </div>
            <Textarea
              id="prompt-text"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder={t(
                "settings.postProcessing.prompts.promptInstructionsPlaceholder",
              )}
            />
          </div>
          <div className="v-row min-h-[54px]">
            {isCreating ? (
              <>
                <Button
                  onClick={handleCancelCreate}
                  variant="ghost"
                  className="-ms-2"
                >
                  {t("settings.postProcessing.prompts.cancel")}
                </Button>
                <Button
                  onClick={handleCreatePrompt}
                  disabled={!draftName.trim() || !draftText.trim()}
                >
                  {t("settings.postProcessing.prompts.createPrompt")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={() => handleDeletePrompt(selectedPromptId)}
                  variant="danger-ghost"
                  className="-ms-2"
                  disabled={!selectedPromptId || prompts.length <= 1}
                >
                  {t("settings.postProcessing.prompts.deletePrompt")}
                </Button>
                <Button
                  onClick={handleUpdatePrompt}
                  disabled={!draftName.trim() || !draftText.trim() || !isDirty}
                >
                  {t("settings.postProcessing.prompts.updatePrompt")}
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {!editing && (
        <div className="v-row">
          <p className="v-meta">
            {hasPrompts
              ? t("settings.postProcessing.prompts.selectToEdit")
              : t("settings.postProcessing.prompts.createFirst")}
          </p>
        </div>
      )}
    </>
  );
};

export const PostProcessingSettingsApi = React.memo(
  PostProcessingSettingsApiComponent,
);
PostProcessingSettingsApi.displayName = "PostProcessingSettingsApi";

export const PostProcessingSettingsPrompts = React.memo(
  PostProcessingSettingsPromptsComponent,
);
PostProcessingSettingsPrompts.displayName = "PostProcessingSettingsPrompts";

export const PostProcessingSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="w-full">
      <PageHeader title={t("sidebar.postProcessing")} />
      <SettingsGroup title={t("settings.postProcessing.hotkey.title")}>
        <ShortcutInput
          shortcutId="transcribe_with_post_process"
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.postProcessing.api.title")}>
        <PostProcessingSettingsApi />
      </SettingsGroup>

      <SettingsGroup title={t("settings.postProcessing.prompts.title")}>
        <PostProcessingSettingsPrompts />
      </SettingsGroup>
    </div>
  );
};
