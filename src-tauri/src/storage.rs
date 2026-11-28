//! The Storage page (onboarding step 7 and Settings, rows 25 to 27): what
//! Voce keeps on this Mac and its size, the disk's space, and removal of the
//! items the page offers a trash icon for. Never removable: the speech model
//! in use, the runtime, and call data in bulk (calls are deleted in Calls).
//! The data folder opens in Finder through the existing `open_app_data_dir`.

use crate::managers::history::HistoryManager;
use crate::managers::model::ModelManager;
use crate::settings::get_settings;
use serde::Serialize;
use specta::Type;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum StorageKind {
    SpeechModel,
    MeetingModel,
    CleanupModel,
    Runtime,
    Recordings,
    CallData,
    History,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct StorageItem {
    /// Pass to `remove_storage_item`. Speech models are `speech:<model id>`.
    pub id: String,
    pub kind: StorageKind,
    /// The model's name for models; empty otherwise.
    pub name: String,
    /// Bytes on disk (HF cache files included; within a few percent).
    pub bytes: f64,
    /// Calls or dictations, for call data and history.
    pub count: Option<u32>,
    pub in_use: bool,
    pub removable: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct StorageReport {
    pub items: Vec<StorageItem>,
    pub total_bytes: f64,
    pub disk_free_bytes: f64,
    pub disk_total_bytes: f64,
}

/// Which items get a trash icon (row 26: never a model in use).
pub fn removable(kind: StorageKind, in_use: bool) -> bool {
    match kind {
        StorageKind::SpeechModel | StorageKind::MeetingModel | StorageKind::CleanupModel => !in_use,
        StorageKind::Recordings | StorageKind::History => true,
        StorageKind::Runtime | StorageKind::CallData => false,
    }
}

/// A downloaded speech model, never the cleanup model under another name.
fn is_speech_entry(model: &crate::managers::model::ModelInfo) -> bool {
    model.is_downloaded && model.filename != crate::local_llm::MODEL_FILE
}

/// Voce cleanup is the chosen cleanup, or its server is serving now.
fn cleanup_in_use(settings: &crate::settings::AppSettings) -> bool {
    (settings.post_process_enabled
        && settings.post_process_provider_id == crate::settings::VOCE_LOCAL_PROVIDER_ID)
        || crate::local_llm::sidecar().is_some_and(|s| s.in_use())
}

/// A call is recording (its live transcript runs on the meeting model).
fn meeting_in_use(app: &AppHandle) -> bool {
    app.try_state::<crate::calls::CallNotesManager>()
        .is_some_and(|calls| calls.is_active())
}

fn set_in_use(mut item: StorageItem, in_use: bool) -> StorageItem {
    item.in_use = in_use;
    item.removable = removable(item.kind, in_use);
    item
}

/// Size of a file or folder; symlinks (the HF cache's snapshots) are
/// followed to what they point at.
pub fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| size_of(&e.path())).sum())
        .unwrap_or(0)
}

/// (free, total) bytes of the disk holding `path`.
#[cfg(unix)]
fn disk_space(path: &Path) -> (u64, u64) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return (0, 0);
    };
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return (0, 0);
    }
    let block = stat.f_frsize as u64;
    (stat.f_bavail as u64 * block, stat.f_blocks as u64 * block)
}

#[cfg(not(unix))]
fn disk_space(_path: &Path) -> (u64, u64) {
    (0, 0)
}

fn item(id: &str, kind: StorageKind, bytes: u64, count: Option<u32>) -> StorageItem {
    StorageItem {
        id: id.to_string(),
        kind,
        name: String::new(),
        bytes: bytes as f64,
        count,
        in_use: false,
        removable: removable(kind, false),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_storage_report(app: AppHandle) -> Result<StorageReport, String> {
    tauri::async_runtime::spawn_blocking(move || report(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn report(app: &AppHandle) -> Result<StorageReport, String> {
    let data = crate::portable::app_data_dir(app).map_err(|e| e.to_string())?;
    let settings = get_settings(app);
    let selected = settings.selected_model.clone();
    let models = app.state::<Arc<ModelManager>>();
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for model in models.get_available_models() {
        if !is_speech_entry(&model) {
            continue;
        }
        let Ok(path) = models.get_model_path(&model.id) else {
            continue;
        };
        if !seen.insert(path.canonicalize().unwrap_or(path.clone())) {
            continue;
        }
        let in_use = model.id == selected;
        items.push(StorageItem {
            id: format!("speech:{}", model.id),
            kind: StorageKind::SpeechModel,
            name: model.name.clone(),
            bytes: size_of(&path) as f64,
            count: None,
            in_use,
            removable: removable(StorageKind::SpeechModel, in_use),
        });
    }
    let meeting = size_of(&data.join("stream-asr"));
    if meeting > 0 {
        items.push(set_in_use(
            item("meeting_model", StorageKind::MeetingModel, meeting, None),
            meeting_in_use(app),
        ));
    }
    let cleanup = crate::local_llm::model_path(&crate::local_llm::cleanup_dir(&data));
    if cleanup.is_file() {
        let mut cleanup_item = item(
            "cleanup_model",
            StorageKind::CleanupModel,
            size_of(&cleanup),
            None,
        );
        cleanup_item.name = "s1-mini".into();
        items.push(set_in_use(cleanup_item, cleanup_in_use(&settings)));
    }
    // The bundled sidecar (or the dev override) plus the runtime folder.
    let runtime = size_of(&data.join("runtime"))
        + crate::local_llm::server_binary()
            .and_then(|bin| bin.parent().map(sidecar_size))
            .unwrap_or(0);
    items.push(item("runtime", StorageKind::Runtime, runtime, None));
    let history = app.state::<Arc<HistoryManager>>();
    items.push(item(
        "recordings",
        StorageKind::Recordings,
        size_of(history.recordings_dir()),
        None,
    ));
    let calls = data.join("calls");
    let call_count = std::fs::read_dir(&calls)
        .map(|e| e.flatten().filter(|e| e.path().is_dir()).count())
        .unwrap_or(0);
    items.push(item(
        "call_data",
        StorageKind::CallData,
        size_of(&calls),
        Some(call_count as u32),
    ));
    items.push(item(
        "history",
        StorageKind::History,
        size_of(&data.join("history.db")),
        Some(history.count_entries().unwrap_or(0) as u32),
    ));
    let (free, total) = disk_space(&data);
    Ok(StorageReport {
        total_bytes: items.iter().map(|i| i.bytes).sum(),
        items,
        disk_free_bytes: free as f64,
        disk_total_bytes: total as f64,
    })
}

/// llama-server and its dylibs (the folder also holds Voce itself when bundled).
fn sidecar_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    name.starts_with("llama-server")
                        || (name.starts_with("lib") && name.ends_with(".dylib"))
                })
                .map(|e| size_of(&e.path()))
                .sum()
        })
        .unwrap_or(0)
}

#[tauri::command]
#[specta::specta]
pub async fn remove_storage_item(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}

fn remove(app: &AppHandle, id: &str) -> Result<(), String> {
    let data = crate::portable::app_data_dir(app).map_err(|e| e.to_string())?;
    if let Some(model_id) = id.strip_prefix("speech:") {
        // The cleanup model is removed only through its own reserved path.
        let models = app.state::<Arc<ModelManager>>();
        if models
            .get_model_info(model_id)
            .is_some_and(|m| m.filename == crate::local_llm::MODEL_FILE)
        {
            return Err("the cleanup model is removed as cleanup_model".into());
        }
        let in_use = get_settings(app).selected_model == model_id;
        if !removable(StorageKind::SpeechModel, in_use) {
            return Err("the speech model in use cannot be removed".into());
        }
        return app
            .state::<Arc<ModelManager>>()
            .delete_model(model_id)
            .map_err(|e| e.to_string());
    }
    let history = app.state::<Arc<HistoryManager>>();
    match id {
        "meeting_model" if !removable(StorageKind::MeetingModel, meeting_in_use(app)) => {
            Err("the meeting model is in use during a call".into())
        }
        "cleanup_model"
            if !removable(
                StorageKind::CleanupModel,
                cleanup_in_use(&get_settings(app)),
            ) =>
        {
            Err("the cleanup model in use cannot be removed".into())
        }
        "meeting_model" => {
            let dir = data.join("stream-asr");
            if dir.exists() {
                std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        "cleanup_model" => crate::local_llm::remove_model(),
        "recordings" => history
            .delete_unsaved_audio()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        "history" => history
            .clear_unsaved()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        _ => Err(format!("'{id}' cannot be removed here")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row25_sizes_follow_symlinks_like_the_hf_cache() {
        let dir = tempfile::tempdir().unwrap();
        let blob = dir.path().join("blobs").join("abc");
        std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
        std::fs::write(&blob, vec![0u8; 4096]).unwrap();
        let snapshot = dir.path().join("snapshots").join("rev");
        std::fs::create_dir_all(&snapshot).unwrap();
        std::os::unix::fs::symlink(&blob, snapshot.join("model.gguf")).unwrap();
        assert_eq!(size_of(&snapshot.join("model.gguf")), 4096);
        assert_eq!(size_of(&snapshot), 4096);
        let (free, total) = disk_space(dir.path());
        assert!(total > 0 && free <= total);
    }

    #[test]
    fn row26_the_model_in_use_runtime_and_call_data_are_never_removable() {
        for model in [
            StorageKind::SpeechModel,
            StorageKind::MeetingModel,
            StorageKind::CleanupModel,
        ] {
            assert!(!removable(model, true), "{model:?} in use");
            assert!(removable(model, false));
        }
        assert!(!removable(StorageKind::Runtime, false));
        assert!(!removable(StorageKind::CallData, false));
        for kind in [StorageKind::Recordings, StorageKind::History] {
            assert!(removable(kind, false));
        }
    }

    #[test]
    fn review3_storage_lists_the_cleanup_model_only_as_cleanup() {
        let mut speech: crate::managers::model::ModelInfo =
            serde_json::from_value(serde_json::json!({
                "id": "whisper-small", "name": "Whisper Small", "description": "",
                "filename": "ggml-small.bin", "source": "Local", "size_mb": 465,
                "is_downloaded": true, "is_downloading": false, "partial_size": 0,
                "is_directory": false, "engine_type": "TranscribeCpp", "accuracy_score": 0.5,
                "speed_score": 0.5, "supports_translation": false, "is_recommended": false,
                "supported_languages": [], "supports_language_selection": false,
                "is_custom": true, "supports_streaming": false,
                "supports_language_detection": false
            }))
            .unwrap();
        speech.is_downloaded = true;
        assert!(is_speech_entry(&speech));
        let mut cleanup = speech.clone();
        cleanup.filename = crate::local_llm::MODEL_FILE.into();
        assert!(!is_speech_entry(&cleanup), "never a removable speech entry");
    }

    #[test]
    fn row26_voce_cleanup_chosen_means_its_model_is_in_use() {
        let mut settings = crate::settings::get_default_settings();
        assert!(!cleanup_in_use(&settings));
        crate::cleanup_setup::apply_choice(
            &mut settings,
            &crate::cleanup_setup::CleanupChoice::VoceLocal,
        );
        assert!(cleanup_in_use(&settings));
        crate::cleanup_setup::apply_off(&mut settings);
        assert!(!cleanup_in_use(&settings));
    }
}
