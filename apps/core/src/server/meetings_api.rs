//! HTTP API for meeting notes (`/api/meetings/*`).
//!
//! CRUD over meetings, multipart chunk ingest (transcribe → append → broadcast),
//! finalize (gateway note generation), a full-transcript read, an SSE event
//! stream, the Shadow detection hook, and the detection-config KV.
//!
//! Per the Core-vs-Gateway rule this is **Core** — it decides *what runs* (start
//! a recording, transcribe a chunk, ask a model for notes). Audio capture is a
//! device-bound sensor and lives in Shadow; this surface only ingests the chunks
//! Shadow streams up.

use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::meetings::{
    notes::{MeetingNotes, DEFAULT_NOTES_PROMPT},
    Meeting, MeetingSource,
};

/// The Space that auto-saved meeting notes land in. Reusing the Spaces feature
/// gives editing (the PlateJS markdown editor) + RAG search for free — the only
/// difference from a hand-written Space doc is how the data got in.
const MEETINGS_SPACE_NAME: &str = "Meetings";

const NOTES_MODEL_PREF: &str = "meeting-notes-model";
const NOTES_EFFORT_PREF: &str = "meeting-notes-effort";
const NOTES_PROMPT_PREF: &str = "meeting-notes-prompt";
const DETECTION_APPS_PREF: &str = "meeting-detection-apps";
const DETECTION_ENABLED_PREF: &str = "meeting-detection-enabled";

/// Default processes whose mic use is treated as "you're in a meeting". The
/// detector (Shadow) matches a foreground/mic-owning process against this list;
/// it is a *swappable default*, editable via the detection-config endpoint.
const DEFAULT_MEETING_APPS: &[&str] = &[
    "zoom", "teams", "meet", "slack", "discord", "webex", "skype", "facetime", "whereby", "around",
    "gather", "huddle",
];

// ---- model / prompt resolution (nothing hardcoded) ------------------------

async fn resolve_notes_model(state: &ServerState) -> String {
    if let Ok(Some(pref)) = state.preferences.get(NOTES_MODEL_PREF).await {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    for var in ["RYU_MEETING_NOTES_MODEL", "RYU_DEFAULT_LLM_MODEL"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                return val;
            }
        }
    }
    crate::registry::DEFAULT_LLM_MODEL.to_string()
}

async fn resolve_notes_effort(state: &ServerState) -> String {
    if let Ok(Some(pref)) = state.preferences.get(NOTES_EFFORT_PREF).await {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    std::env::var("RYU_MEETING_NOTES_EFFORT")
        .ok()
        .unwrap_or_default()
}

async fn resolve_notes_prompt(state: &ServerState) -> String {
    if let Ok(Some(pref)) = state.preferences.get(NOTES_PROMPT_PREF).await {
        let trimmed = pref.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    DEFAULT_NOTES_PROMPT.to_string()
}

// ---- meetings CRUD --------------------------------------------------------

/// `GET /api/meetings` — list all meetings, newest first.
pub async fn list_meetings(State(state): State<ServerState>) -> Json<serde_json::Value> {
    match state.meetings.list().await {
        Ok(meetings) => Json(json!({ "meetings": meetings })),
        Err(e) => Json(json!({ "meetings": [], "error": e })),
    }
}

/// Request body for starting a meeting.
#[derive(Debug, Deserialize)]
pub struct StartBody {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

/// `POST /api/meetings` — start a meeting (and best-effort begin Shadow capture).
pub async fn create_meeting(
    State(state): State<ServerState>,
    Json(body): Json<StartBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let source = match body.source.as_deref() {
        Some("auto") => MeetingSource::Auto,
        _ => MeetingSource::Manual,
    };
    match state.meetings.start(body.title, body.app, source).await {
        Ok(meeting) => (StatusCode::OK, Json(json!({ "meeting": meeting }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

/// `GET /api/meetings/:id` — one meeting (without the transcript body).
pub async fn get_meeting(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.meetings.get(&id).await {
        Ok(Some(m)) => (StatusCode::OK, Json(json!({ "meeting": m }))),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

/// Request body for renaming a meeting.
#[derive(Debug, Deserialize)]
pub struct RenameBody {
    pub title: String,
}

/// `POST /api/meetings/:id/title` — manually rename a meeting. Marks the title
/// user-chosen so the transcript auto-namer leaves it alone.
pub async fn rename_meeting(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let title = body.title.trim();
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "title must not be empty" })),
        );
    }
    match state.meetings.store.set_title(&id, title).await {
        Ok(Some(m)) => (StatusCode::OK, Json(json!({ "meeting": m }))),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `DELETE /api/meetings/:id` — remove a meeting and its transcript.
pub async fn delete_meeting(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.meetings.delete(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

/// Optional `?engine=` selector mirroring the voice transcribe route.
#[derive(Debug, Deserialize)]
pub struct ChunkQuery {
    #[serde(default)]
    pub engine: Option<String>,
}

/// `POST /api/meetings/:id/chunk` — ingest one captured WAV chunk (multipart
/// `file` field), transcribe it, and append it to the live transcript.
pub async fn ingest_chunk(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<ChunkQuery>,
    mut multipart: Multipart,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut audio: Option<(String, Vec<u8>)> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            let filename = field
                .file_name()
                .map(str::to_string)
                .unwrap_or_else(|| "chunk.wav".to_string());
            match field.bytes().await {
                Ok(bytes) => audio = Some((filename, bytes.to_vec())),
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": format!("could not read audio field: {e}") })),
                    );
                }
            }
        }
    }
    let Some((filename, bytes)) = audio else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing `file` field (the audio chunk)" })),
        );
    };

    match state
        .meetings
        .ingest_chunk(&id, bytes, filename, query.engine.as_deref())
        .await
    {
        Ok(segment) => (StatusCode::OK, Json(json!({ "segment": segment }))),
        // A silent chunk is not an error worth a 5xx — report it softly.
        Err(e) if e.contains("silence") => (
            StatusCode::OK,
            Json(json!({ "segment": null, "skipped": e })),
        ),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

/// `GET /api/meetings/:id/transcript` — the full transcript (segments + text).
pub async fn get_transcript(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let segments = match state.meetings.store.list_segments(&id).await {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    let text = segments
        .iter()
        .map(|s| s.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    (
        StatusCode::OK,
        Json(json!({ "segments": segments, "text": text })),
    )
}

/// `POST /api/meetings/:id/finalize` — stop capture, generate notes, mark done,
/// and save the notes into the "Meetings" Space so they're editable + searchable
/// through the existing Spaces UI (best-effort; a Space failure doesn't fail the
/// finalize — the notes still live on the meeting record).
pub async fn finalize_meeting(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let model = resolve_notes_model(&state).await;
    let effort = resolve_notes_effort(&state).await;
    let prompt = resolve_notes_prompt(&state).await;
    let mut meeting = match state.meetings.finalize(&id, &model, &effort, &prompt).await {
        Ok(m) => m,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    };

    // Auto-name the meeting from its summary with the default local model, unless
    // the user already chose a title. Best-effort; on success update the local
    // copy so the Space document below uses the new title.
    if !meeting.title_custom {
        if let Some(summary) = meeting.notes.as_ref().map(|n| n.summary.clone()) {
            if let Some(new_title) =
                super::auto_title::auto_title_meeting(&state, &id, &summary).await
            {
                meeting.title = new_title;
            }
        }
    }

    let final_meeting = match save_notes_to_space(&state, &meeting).await {
        Some((space_id, doc_id)) => state
            .meetings
            .attach_space(&id, &space_id, &doc_id)
            .await
            .unwrap_or(meeting),
        None => meeting,
    };
    (StatusCode::OK, Json(json!({ "meeting": final_meeting })))
}

/// Write a finalized meeting's notes (+ transcript) into the Meetings Space as a
/// markdown document. Returns `(space_id, doc_id)` on success, `None` on any
/// failure (logged) so finalize stays best-effort.
async fn save_notes_to_space(state: &ServerState, meeting: &Meeting) -> Option<(String, String)> {
    let notes = meeting.notes.as_ref()?;
    let transcript = state
        .meetings
        .transcript(&meeting.id)
        .await
        .unwrap_or_default();
    let markdown = build_notes_markdown(meeting, notes, &transcript);
    let space_id = ensure_meetings_space(state).await?;
    match state
        .spaces
        .ingest_document(&space_id, &meeting.title, &markdown)
        .await
    {
        Ok(doc_id) => Some((space_id, doc_id)),
        Err(e) => {
            tracing::warn!("meetings: saving notes to space failed: {e:#}");
            None
        }
    }
}

/// Find the "Meetings" space, creating it on first use. Returns its id, or `None`
/// if the spaces store is unavailable.
async fn ensure_meetings_space(state: &ServerState) -> Option<String> {
    match state.spaces.list_spaces().await {
        Ok(spaces) => {
            if let Some(space) = spaces.iter().find(|s| s.name == MEETINGS_SPACE_NAME) {
                return Some(space.id.clone());
            }
        }
        Err(e) => tracing::warn!("meetings: listing spaces failed: {e:#}"),
    }
    match state
        .spaces
        .create_space(MEETINGS_SPACE_NAME, Some("Auto-saved meeting notes"))
        .await
    {
        Ok(id) => Some(id),
        Err(e) => {
            tracing::warn!("meetings: creating Meetings space failed: {e:#}");
            None
        }
    }
}

/// Render a meeting's notes + transcript as a markdown document for the Space.
fn build_notes_markdown(meeting: &Meeting, notes: &MeetingNotes, transcript: &str) -> String {
    fn bullets(items: &[String]) -> String {
        if items.is_empty() {
            return "_None_".to_string();
        }
        items
            .iter()
            .map(|i| format!("- {i}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    let subtitle = match &meeting.app {
        Some(app) if !app.is_empty() => format!("{app} · {}", meeting.started_at),
        _ => meeting.started_at.clone(),
    };
    let mut md = format!("# {}\n\n_{subtitle}_\n\n", meeting.title);
    md.push_str(&format!("## Summary\n\n{}\n\n", notes.summary));
    md.push_str(&format!(
        "## Key points\n\n{}\n\n",
        bullets(&notes.key_points)
    ));
    md.push_str(&format!(
        "## Action items\n\n{}\n\n",
        bullets(&notes.action_items)
    ));
    md.push_str(&format!(
        "## Decisions\n\n{}\n\n",
        bullets(&notes.decisions)
    ));
    if !transcript.trim().is_empty() {
        md.push_str(&format!("## Transcript\n\n{transcript}\n"));
    }
    md
}

/// `GET /api/meetings/stream` — SSE feed of meeting events (detected / started /
/// segment / status / finalized).
pub async fn meetings_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = state.meetings.store.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Request body Shadow posts when it detects a process using the microphone.
#[derive(Debug, Deserialize)]
pub struct DetectBody {
    /// The owning process / app slug (e.g. `zoom`).
    pub app: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// `POST /api/meetings/detect` — Shadow's mic-in-use detection hook. Shadow
/// reports the *raw* process currently using the microphone; Core is the brain
/// that decides whether it's a meeting: it filters against the configured
/// meeting-app list, debounces, then broadcasts a `detected` event so the island
/// can prompt to start notes.
pub async fn detect(
    State(state): State<ServerState>,
    Json(body): Json<DetectBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Respect the master toggle.
    if let Ok(Some(v)) = state.preferences.get(DETECTION_ENABLED_PREF).await {
        if v.trim() == "false" {
            return (
                StatusCode::OK,
                Json(json!({ "broadcast": false, "reason": "detection disabled" })),
            );
        }
    }

    // Only meeting apps trigger a prompt — a process using the mic for dictation
    // or a voice note shouldn't pop "start meeting notes?". An empty list means
    // "match nothing extra"; we always fall back to the built-in defaults so the
    // feature works before the user customizes anything.
    let apps = state
        .preferences
        .get(DETECTION_APPS_PREF)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_else(|| DEFAULT_MEETING_APPS.iter().map(|s| s.to_string()).collect());
    let app_lower = body.app.to_lowercase();
    let matched = apps
        .iter()
        .find(|slug| !slug.trim().is_empty() && app_lower.contains(&slug.to_lowercase()))
        .cloned();
    let Some(slug) = matched else {
        return (
            StatusCode::OK,
            Json(json!({ "broadcast": false, "reason": "not a known meeting app" })),
        );
    };

    let broadcast = state
        .meetings
        .record_detection(&slug, body.title.as_deref())
        .await;
    (StatusCode::OK, Json(json!({ "broadcast": broadcast })))
}

/// `GET /api/meetings/detection-config` — the detection toggle + meeting-app list.
pub async fn get_detection_config(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let enabled = state
        .preferences
        .get(DETECTION_ENABLED_PREF)
        .await
        .ok()
        .flatten()
        .map(|v| v.trim() != "false")
        .unwrap_or(true);
    let apps = state
        .preferences
        .get(DETECTION_APPS_PREF)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_else(|| DEFAULT_MEETING_APPS.iter().map(|s| s.to_string()).collect());
    Json(json!({ "enabled": enabled, "apps": apps }))
}

/// Request body for updating the detection config.
#[derive(Debug, Deserialize)]
pub struct DetectionConfigBody {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub apps: Option<Vec<String>>,
}

/// `PUT /api/meetings/detection-config` — update the toggle and/or app list.
pub async fn put_detection_config(
    State(state): State<ServerState>,
    Json(body): Json<DetectionConfigBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Some(enabled) = body.enabled {
        let _ = state
            .preferences
            .set(
                DETECTION_ENABLED_PREF,
                if enabled { "true" } else { "false" },
            )
            .await;
    }
    if let Some(apps) = body.apps {
        let json = serde_json::to_string(&apps).unwrap_or_else(|_| "[]".to_string());
        let _ = state.preferences.set(DETECTION_APPS_PREF, &json).await;
    }
    (StatusCode::OK, get_detection_config(State(state)).await)
}
