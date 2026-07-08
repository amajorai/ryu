//! Meeting notes (Granola / Notion-AI style): record a call, transcribe it live,
//! and generate AI notes when it ends — with automatic detection of an in-progress
//! meeting so notes can start without opening any app.
//!
//! ## Where the pieces live (Core vs sensor)
//! - **Core (this module)** is the brain: it owns the meeting session lifecycle,
//!   the chunked-transcription pipeline (reusing the existing whisper/parakeet
//!   voice path), transcript accumulation, AI note generation (via the gateway),
//!   persistence, and the live SSE event stream. It decides *what runs*.
//! - **Audio capture is a device-bound sensor**, not Core: Core can run on a
//!   remote node, so it must not grab the local machine's audio. Capture (mic +
//!   system loopback) lives in **Shadow**, which streams raw WAV chunks up to
//!   `POST /api/meetings/:id/chunk`. Core only ingests + transcribes them.
//!
//! ## The detection mechanic
//! Granola/Notion do not trigger on "the meeting app is focused" — they watch the
//! OS for *a process actively using the microphone* (Windows
//! `CapabilityAccessManager`; macOS `kAudioDevicePropertyDeviceIsRunningSomewhere`).
//! That OS-level signal is device-local, so Shadow detects it and POSTs to
//! `POST /api/meetings/detect`; Core debounces it and broadcasts a `detected`
//! event, which the island surfaces as a "start notes?" prompt.

pub mod audio;
pub mod diarize;
pub mod notes;
pub mod store;
pub mod templates;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

pub use notes::MeetingNotes;
use store::MeetingStore;

/// Process-global meeting engine, set once at startup from `main.rs`.
///
/// Mirrors [`crate::monitors`]: off-`ServerState` callers (e.g. a future
/// scheduled summarizer, or Shadow control proxying) read the engine here.
static ENGINE: std::sync::OnceLock<MeetingEngine> = std::sync::OnceLock::new();

/// Publish the global engine. Idempotent: a second call is ignored.
pub fn set_global_engine(engine: MeetingEngine) {
    let _ = ENGINE.set(engine);
}

/// The global engine, if it has been published.
pub fn global_engine() -> Option<&'static MeetingEngine> {
    ENGINE.get()
}

/// Default Shadow base URL Core uses to drive device-local capture. Overridable
/// via `RYU_SHADOW_URL` (the "nothing hardcoded" knob); Shadow is the local
/// sensor, so this stays loopback by default.
fn shadow_url() -> String {
    std::env::var("RYU_SHADOW_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:3030".to_string())
}

/// A meeting's lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingStatus {
    /// Auto-detected but the user has not started notes yet (transient; only used
    /// when we choose to persist a detection).
    Detected,
    /// Actively recording + transcribing.
    Recording,
    /// Recording stopped; notes are being generated.
    Processing,
    /// Finished, notes available.
    Done,
}

/// How a meeting came to exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingSource {
    /// The user pressed record.
    #[default]
    Manual,
    /// Started from an auto-detection prompt.
    Auto,
}

/// A recorded meeting (the unit the REST API and GUIs deal with).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    /// Whether the title was chosen by the user (manual rename) rather than the
    /// default/auto-generated one. Gates the background auto-namer the same way
    /// `title_custom` does for conversations: once the user renames a meeting,
    /// auto-naming from the transcript leaves it alone. Defaults false so older
    /// rows (and freshly-started meetings with a default title) stay eligible.
    #[serde(default)]
    pub title_custom: bool,
    /// The detected meeting app (e.g. `zoom`, `teams`), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default)]
    pub source: MeetingSource,
    pub status: MeetingStatus,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Free-form participant labels (optional; diarization is future work).
    #[serde(default)]
    pub participants: Vec<String>,
    /// Generated notes, present once finalized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<MeetingNotes>,
    /// The Space the finalized notes were saved into (reuses the Spaces feature
    /// for storage + editing). Set on finalize; `None` until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    /// The Space document holding the editable notes markdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One transcribed audio chunk in a meeting's live transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub id: i64,
    pub meeting_id: String,
    /// Milliseconds from the meeting start (best-effort ordering hint).
    pub t_offset_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    pub text: String,
    pub created_at: String,
}

/// Live events broadcast over SSE to the desktop + island.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MeetingEvent {
    /// A meeting was detected as starting (a process is using the mic). Carries
    /// no meeting id — the client decides whether to start notes.
    Detected {
        app: String,
        title: String,
        detected_at: String,
    },
    /// A meeting started recording.
    Started { meeting: Meeting },
    /// A new transcript segment was appended.
    Segment { segment: Segment },
    /// A meeting's status changed (e.g. recording → processing).
    Status {
        meeting_id: String,
        status: MeetingStatus,
    },
    /// A meeting was finalized with notes.
    Finalized { meeting: Meeting },
}

/// The meeting runtime: holds the store, an HTTP client (for transcription proxy,
/// note-gen, and driving Shadow capture), and a small in-memory detection
/// debounce. Cheap to clone.
#[derive(Clone)]
pub struct MeetingEngine {
    pub store: MeetingStore,
    http: reqwest::Client,
    /// Last detection (app, when) for debouncing repeated mic-in-use signals.
    last_detect: Arc<Mutex<Option<(String, Instant)>>>,
}

impl MeetingEngine {
    pub fn new(store: MeetingStore, http: reqwest::Client) -> Self {
        Self {
            store,
            http,
            last_detect: Arc::new(Mutex::new(None)),
        }
    }

    /// Start a new meeting: persist it as `recording` and best-effort tell Shadow
    /// to begin device-local capture (mic + system loopback) streaming chunks
    /// back to `POST /api/meetings/:id/chunk`. Returns the created meeting.
    pub async fn start(
        &self,
        title: String,
        app: Option<String>,
        source: MeetingSource,
    ) -> Result<Meeting, String> {
        let now = chrono::Utc::now().to_rfc3339();
        // A user-supplied start title counts as custom (no auto-rename); an empty
        // one falls back to the app default and stays eligible for auto-naming
        // once the transcript gives the model something to work with.
        let user_titled = !title.trim().is_empty();
        let meeting = Meeting {
            id: format!("mtg_{}", uuid::Uuid::new_v4().simple()),
            title: if user_titled {
                title
            } else {
                default_title(app.as_deref())
            },
            title_custom: user_titled,
            app,
            source,
            status: MeetingStatus::Recording,
            started_at: now.clone(),
            ended_at: None,
            participants: Vec::new(),
            notes: None,
            space_id: None,
            doc_id: None,
            created_at: now.clone(),
            updated_at: now,
        };
        self.store
            .upsert_meeting(&meeting)
            .await
            .map_err(|e| e.to_string())?;
        self.store.emit(MeetingEvent::Started {
            meeting: meeting.clone(),
        });
        // Best-effort: drive Shadow capture. A missing/absent Shadow must not fail
        // the meeting — the user can also feed chunks from the GUI mic.
        self.notify_shadow_start(&meeting.id).await;
        Ok(meeting)
    }

    /// Create a meeting for an **imported** audio file. Like [`Self::start`] but it
    /// does not drive Shadow capture — the audio comes from the uploaded file,
    /// which the caller feeds through [`Self::ingest_chunk`] window by window.
    pub async fn start_import(&self, title: String) -> Result<Meeting, String> {
        let now = chrono::Utc::now().to_rfc3339();
        let user_titled = !title.trim().is_empty();
        let meeting = Meeting {
            id: format!("mtg_{}", uuid::Uuid::new_v4().simple()),
            title: if user_titled {
                title
            } else {
                default_title(None)
            },
            title_custom: user_titled,
            app: Some("import".to_string()),
            source: MeetingSource::Manual,
            status: MeetingStatus::Recording,
            started_at: now.clone(),
            ended_at: None,
            participants: Vec::new(),
            notes: None,
            space_id: None,
            doc_id: None,
            created_at: now.clone(),
            updated_at: now,
        };
        self.store
            .upsert_meeting(&meeting)
            .await
            .map_err(|e| e.to_string())?;
        self.store.emit(MeetingEvent::Started {
            meeting: meeting.clone(),
        });
        Ok(meeting)
    }

    /// Ingest one captured audio chunk: downmix it to mono for transcription
    /// (whisper default, or the requested engine), persist the stereo audio for
    /// later diarization, append the text as a transcript segment, and broadcast
    /// it. `offset_ms` is the chunk's sample-accurate position from Shadow; when
    /// absent (e.g. a GUI-mic feed) we fall back to wall-clock since start.
    pub async fn ingest_chunk(
        &self,
        meeting_id: &str,
        wav: Vec<u8>,
        filename: String,
        engine: Option<&str>,
        offset_ms: Option<i64>,
    ) -> Result<Segment, String> {
        let meeting = self
            .store
            .get_meeting(meeting_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("meeting '{meeting_id}' not found"))?;

        // Decode once, then fan out: mono for whisper, stereo (16 kHz) persisted
        // for diarization. A decode failure falls back to sending the raw bytes so
        // an odd WAV still transcribes.
        let mono_wav = match audio::decode_wav(&wav) {
            Ok(decoded) => {
                if decoded.rate == audio::TARGET_RATE {
                    let stereo = audio::to_stereo_i16(&decoded);
                    if let Err(e) = audio::append_pcm(meeting_id, &stereo) {
                        tracing::debug!("meetings: persisting chunk audio failed: {e:#}");
                    }
                }
                audio::to_mono_wav(&decoded).unwrap_or(wav)
            }
            Err(_) => wav,
        };

        let text =
            crate::server::voice::transcribe_wav(&self.http, mono_wav, filename, engine).await?;
        let text = text.trim().to_string();
        // Whisper emits blank/placeholder text for silence; skip empty segments so
        // the transcript stays clean.
        if text.is_empty() {
            return Err("empty transcription (silence)".to_string());
        }

        let t_offset_ms = offset_ms.unwrap_or_else(|| millis_since(&meeting.started_at));
        let segment = self
            .store
            .insert_segment(meeting_id, t_offset_ms, None, &text)
            .await
            .map_err(|e| e.to_string())?;
        self.store.emit(MeetingEvent::Segment {
            segment: segment.clone(),
        });
        Ok(segment)
    }

    /// The full transcript as one newline-joined string.
    pub async fn transcript(&self, meeting_id: &str) -> Result<String, String> {
        let segments = self
            .store
            .list_segments(meeting_id)
            .await
            .map_err(|e| e.to_string())?;
        Ok(segments
            .into_iter()
            .map(|s| s.text)
            .collect::<Vec<_>>()
            .join("\n"))
    }

    /// Finalize a meeting: stop Shadow capture, generate notes from the transcript
    /// via the gateway (`model`/`effort`/`prompt` resolved by the caller), persist
    /// them, and mark the meeting done. Returns the updated meeting.
    pub async fn finalize(
        &self,
        meeting_id: &str,
        model: &str,
        effort: &str,
        prompt: &str,
    ) -> Result<Meeting, String> {
        let mut meeting = self
            .store
            .get_meeting(meeting_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("meeting '{meeting_id}' not found"))?;

        // Stop device-local capture first (best-effort).
        self.notify_shadow_stop(meeting_id).await;

        meeting.status = MeetingStatus::Processing;
        meeting.updated_at = chrono::Utc::now().to_rfc3339();
        let _ = self.store.upsert_meeting(&meeting).await;
        self.store.emit(MeetingEvent::Status {
            meeting_id: meeting_id.to_string(),
            status: MeetingStatus::Processing,
        });

        let transcript = self.transcript(meeting_id).await?;
        let notes = if transcript.trim().is_empty() {
            // Nothing was captured — record empty notes rather than calling a model
            // on an empty transcript.
            MeetingNotes {
                summary: "No speech was captured for this meeting.".to_string(),
                ..Default::default()
            }
        } else {
            notes::generate_notes(&self.http, model, effort, prompt, &transcript).await?
        };

        let now = chrono::Utc::now().to_rfc3339();
        meeting.notes = Some(notes);
        meeting.status = MeetingStatus::Done;
        meeting.ended_at = Some(now.clone());
        meeting.updated_at = now;
        self.store
            .upsert_meeting(&meeting)
            .await
            .map_err(|e| e.to_string())?;
        self.store.emit(MeetingEvent::Finalized {
            meeting: meeting.clone(),
        });
        Ok(meeting)
    }

    /// Link a finalized meeting to the Space document its notes were saved into,
    /// so the GUI can open the editable notes in the existing Spaces editor.
    /// Persists the linkage and re-broadcasts the meeting. Returns the updated
    /// meeting (or the unchanged one if it no longer exists).
    pub async fn attach_space(
        &self,
        meeting_id: &str,
        space_id: &str,
        doc_id: &str,
    ) -> Result<Meeting, String> {
        let mut meeting = self
            .store
            .get_meeting(meeting_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("meeting '{meeting_id}' not found"))?;
        meeting.space_id = Some(space_id.to_string());
        meeting.doc_id = Some(doc_id.to_string());
        meeting.updated_at = chrono::Utc::now().to_rfc3339();
        self.store
            .upsert_meeting(&meeting)
            .await
            .map_err(|e| e.to_string())?;
        self.store.emit(MeetingEvent::Finalized {
            meeting: meeting.clone(),
        });
        Ok(meeting)
    }

    /// Record a mic-in-use detection from Shadow and broadcast it — debounced so a
    /// continuously-running call doesn't spam the prompt. Returns true when the
    /// event was broadcast (i.e. it was a fresh detection).
    pub async fn record_detection(&self, app: &str, title: Option<&str>) -> bool {
        const DEBOUNCE: Duration = Duration::from_secs(120);
        {
            let mut last = self.last_detect.lock().await;
            if let Some((prev_app, when)) = last.as_ref() {
                if prev_app == app && when.elapsed() < DEBOUNCE {
                    return false;
                }
            }
            *last = Some((app.to_string(), Instant::now()));
        }
        self.store.emit(MeetingEvent::Detected {
            app: app.to_string(),
            title: title
                .map(str::to_string)
                .unwrap_or_else(|| default_title(Some(app))),
            detected_at: chrono::Utc::now().to_rfc3339(),
        });
        true
    }

    pub async fn list(&self) -> Result<Vec<Meeting>, String> {
        self.store.list_meetings().await.map_err(|e| e.to_string())
    }

    pub async fn get(&self, id: &str) -> Result<Option<Meeting>, String> {
        self.store.get_meeting(id).await.map_err(|e| e.to_string())
    }

    pub async fn delete(&self, id: &str) -> Result<bool, String> {
        // Best-effort: drop the persisted diarization audio alongside the row.
        audio::remove_pcm(id);
        self.store
            .delete_meeting(id)
            .await
            .map_err(|e| e.to_string())
    }

    // ---- Shadow capture control (best-effort) -----------------------------

    async fn notify_shadow_start(&self, meeting_id: &str) {
        let url = format!("{}/meeting/start", shadow_url().trim_end_matches('/'));
        let body = serde_json::json!({ "meeting_id": meeting_id });
        if let Err(e) = self
            .http
            .post(&url)
            .timeout(Duration::from_secs(5))
            .json(&body)
            .send()
            .await
        {
            tracing::debug!(
                "meetings: shadow capture start not available ({e}); GUI mic can still feed chunks"
            );
        }
    }

    async fn notify_shadow_stop(&self, meeting_id: &str) {
        let url = format!("{}/meeting/stop", shadow_url().trim_end_matches('/'));
        let body = serde_json::json!({ "meeting_id": meeting_id });
        let _ = self
            .http
            .post(&url)
            .timeout(Duration::from_secs(5))
            .json(&body)
            .send()
            .await;
    }
}

/// A friendly default title from the detected app + today's date.
fn default_title(app: Option<&str>) -> String {
    let date = chrono::Local::now().format("%b %-d, %-I:%M %p");
    match app {
        Some(a) if !a.is_empty() => format!("{} meeting — {date}", pretty_app(a)),
        _ => format!("Meeting — {date}"),
    }
}

/// Title-case a known app slug for display.
fn pretty_app(app: &str) -> String {
    match app.to_lowercase().as_str() {
        "zoom" | "zoom.us" => "Zoom".to_string(),
        "teams" | "ms-teams" | "microsoft teams" => "Teams".to_string(),
        "meet" | "google meet" => "Google Meet".to_string(),
        "slack" => "Slack".to_string(),
        "discord" => "Discord".to_string(),
        "webex" => "Webex".to_string(),
        other => {
            let mut c = other.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => other.to_string(),
            }
        }
    }
}

/// Milliseconds between an RFC3339 start time and now (clamped at 0).
fn millis_since(started_at: &str) -> i64 {
    match chrono::DateTime::parse_from_rfc3339(started_at) {
        Ok(start) => {
            let elapsed =
                chrono::Utc::now().signed_duration_since(start.with_timezone(&chrono::Utc));
            elapsed.num_milliseconds().max(0)
        }
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pretty_app_known_and_unknown() {
        assert_eq!(pretty_app("zoom"), "Zoom");
        assert_eq!(pretty_app("google meet"), "Google Meet");
        assert_eq!(pretty_app("acme"), "Acme");
    }

    #[test]
    fn default_title_includes_app() {
        assert!(default_title(Some("zoom")).starts_with("Zoom meeting — "));
        assert!(default_title(None).starts_with("Meeting — "));
    }

    #[test]
    fn millis_since_is_non_negative() {
        let future = (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339();
        assert_eq!(millis_since(&future), 0);
        assert_eq!(millis_since("not-a-date"), 0);
    }
}
