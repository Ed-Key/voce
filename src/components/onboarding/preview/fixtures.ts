import type { ModelInfo } from "@/bindings";

const model = (
  id: string,
  name: string,
  description: string,
  size_mb: number,
  langs: string[],
  extra: Partial<ModelInfo> = {},
): ModelInfo => ({
  id,
  name,
  description,
  filename: `${id}.gguf`,
  source: { HuggingFace: { repo_id: `x/${id}`, revision: "main" } },
  size_mb,
  is_downloaded: false,
  is_downloading: false,
  partial_size: 0,
  is_directory: false,
  engine_type: "Whisper" as ModelInfo["engine_type"],
  accuracy_score: 0.8,
  speed_score: 0.8,
  supports_translation: false,
  is_recommended: false,
  supported_languages: langs,
  supports_language_selection: false,
  is_custom: false,
  supports_streaming: false,
  supports_language_detection: false,
  ...extra,
});

const many = Array.from({ length: 28 }, (_, i) => `l${i}`);

export const FAKE_MODELS: ModelInfo[] = [
  model(
    "p-unified",
    "Parakeet Unified EN 0.6B",
    "Fast and accurate. Shows your words while you speak.",
    697,
    ["en"],
    { is_recommended: true, supports_streaming: true },
  ),
  model(
    "nemotron",
    "Nemotron Streaming 3.5",
    "For other languages. Also live.",
    716,
    many,
    { is_recommended: true, supports_streaming: true },
  ),
  ...Array.from({ length: 12 }, (_, i) =>
    model(
      `other-${i}`,
      `Other model ${i + 1}`,
      "A slower model.",
      300 + i * 40,
      ["en"],
    ),
  ),
];

/** Many models already in the shared cache (a heavy Hugging Face user). */
export const CACHED_MODELS: ModelInfo[] = [
  ...FAKE_MODELS.slice(0, 2),
  ...Array.from({ length: 30 }, (_, i) =>
    model(
      `cached-${i}`,
      `Cached model ${i + 1}`,
      "Already on this Mac.",
      200,
      ["en"],
      { is_downloaded: true },
    ),
  ),
];
