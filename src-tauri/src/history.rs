use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub kind: String, // "scribe" or "readaloud"
    pub text: String,
    pub timestamp: String, // ISO 8601
    pub audio_id: Option<String>,
    /// Scribe v3 entity annotations (names, tools, file names, …) as spans
    /// into `text`. Absent on read-aloud entries and older transcriptions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotations: Vec<Annotation>,
}

/// A highlighted span of a transcription. Offsets are JS string (UTF-16)
/// indices into the entry text — opaque to Rust, only the frontend reads them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub start: usize,
    pub end: usize,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryFile {
    entries: Vec<HistoryEntry>,
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    Ok(config_dir.join("history.json"))
}

fn audio_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let dir = config_dir.join("audio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_history(path: &Path) -> HistoryFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(HistoryFile {
            entries: Vec::new(),
        })
}

fn save_history(path: &Path, history: &HistoryFile) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(history).map_err(|e| e.to_string())?;
    std::fs::write(path, contents).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn save_transcription(
    app: AppHandle,
    text: String,
    annotations: Option<Vec<Annotation>>,
) -> Result<(), String> {
    let path = history_path(&app)?;
    let mut history = load_history(&path);

    let now = chrono::Utc::now();
    let entry = HistoryEntry {
        id: now.timestamp_millis().to_string(),
        kind: "scribe".to_string(),
        text,
        timestamp: now.to_rfc3339(),
        audio_id: None,
        annotations: annotations.unwrap_or_default(),
    };

    history.entries.insert(0, entry);
    if history.entries.len() > MAX_ENTRIES {
        // Remove oldest entries and their audio if any
        let removed: Vec<_> = history.entries.drain(MAX_ENTRIES..).collect();
        if let Ok(base) = audio_dir(&app) {
            for entry in removed {
                if let Some(aid) = entry.audio_id {
                    let _ = std::fs::remove_dir_all(base.join(&aid));
                }
            }
        }
    }

    save_history(&path, &history)?;
    let _ = app.emit("history-updated", ());
    Ok(())
}

#[tauri::command]
pub async fn save_readaloud(app: AppHandle, text: String, audio_id: String) -> Result<(), String> {
    let path = history_path(&app)?;
    let mut history = load_history(&path);

    let now = chrono::Utc::now();
    let entry = HistoryEntry {
        id: now.timestamp_millis().to_string(),
        kind: "readaloud".to_string(),
        text,
        timestamp: now.to_rfc3339(),
        audio_id: Some(audio_id),
        annotations: Vec::new(),
    };

    history.entries.insert(0, entry);
    if history.entries.len() > MAX_ENTRIES {
        let removed: Vec<_> = history.entries.drain(MAX_ENTRIES..).collect();
        if let Ok(base) = audio_dir(&app) {
            for entry in removed {
                if let Some(aid) = entry.audio_id {
                    let _ = std::fs::remove_dir_all(base.join(&aid));
                }
            }
        }
    }

    save_history(&path, &history)?;
    let _ = app.emit("history-updated", ());
    Ok(())
}

#[tauri::command]
pub async fn get_history(app: AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let path = history_path(&app)?;
    let history = load_history(&path);
    Ok(history.entries)
}

#[tauri::command]
pub async fn delete_history_entry(app: AppHandle, id: String) -> Result<(), String> {
    let path = history_path(&app)?;
    let mut history = load_history(&path);

    // Find and remove the entry, cleaning up audio if present
    if let Some(pos) = history.entries.iter().position(|e| e.id == id) {
        let entry = history.entries.remove(pos);
        if let Some(aid) = entry.audio_id {
            if let Ok(base) = audio_dir(&app) {
                let _ = std::fs::remove_dir_all(base.join(&aid));
            }
        }
    }

    save_history(&path, &history)?;
    let _ = app.emit("history-updated", ());
    Ok(())
}

#[tauri::command]
pub async fn clear_history(app: AppHandle) -> Result<(), String> {
    let path = history_path(&app)?;

    // Remove all audio folders
    if let Ok(base) = audio_dir(&app) {
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(&base);
    }

    let history = HistoryFile {
        entries: Vec::new(),
    };
    save_history(&path, &history)?;
    let _ = app.emit("history-updated", ());
    Ok(())
}

#[tauri::command]
pub async fn get_cached_audio(
    app: AppHandle,
    audio_id: String,
    chunk_index: usize,
) -> Result<String, String> {
    let base = audio_dir(&app)?;
    let chunk_path = base
        .join(&audio_id)
        .join(format!("chunk_{chunk_index}.mp3"));

    let bytes = std::fs::read(&chunk_path)
        .map_err(|e| format!("Failed to read cached audio chunk: {e}"))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
