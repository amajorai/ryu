//! Canvas persistence + REST handlers for the node-based creative playground.
//!
//! A "canvas" is a ComfyUI / ElevenLabs-Flows-style board of generation nodes
//! (image / video / text / upload) wired into pipelines. Ryu owns *what runs*
//! (the board + its nodes), so this is Core, not Gateway; the actual model
//! calls each node makes reuse the existing governed media endpoints
//! (`/api/images/generate`, `/api/video/generate`) which already route through
//! the Gateway. Nothing here calls a model.
//!
//! Definitions live under `~/.ryu/canvases/<id>.json`. Nodes / edges / viewport
//! are stored as opaque JSON: the desktop React Flow board owns that schema, so
//! the store is round-trip-safe and never needs to change when a node type is
//! added.

use axum::{http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

fn canvases_dir() -> PathBuf {
    crate::paths::ryu_dir().join("canvases")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Reject ids that could escape the storage directory (only the generated-id
/// charset is allowed: ASCII alphanumeric, `_`, `-`). Excludes `.` and path
/// separators, so `../` traversal and absolute paths are impossible.
fn validate_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A persisted canvas. `nodes` / `edges` are opaque JSON arrays owned by the
/// desktop React Flow board; `viewport` is the saved pan/zoom.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Canvas {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "empty_array")]
    pub nodes: Value,
    #[serde(default = "empty_array")]
    pub edges: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<Value>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn empty_array() -> Value {
    Value::Array(Vec::new())
}

// ── Store ────────────────────────────────────────────────────────────────────

fn save_canvas(canvas: &Canvas) -> std::io::Result<()> {
    if !validate_id(&canvas.id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid canvas id",
        ));
    }
    let dir = canvases_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", canvas.id));
    let json = serde_json::to_string_pretty(canvas)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Atomic write: temp + fsync + rename so a crash mid-write never leaves a
    // torn board file.
    let tmp = dir.join(format!("{}.json.tmp", canvas.id));
    {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?;
    }
    match std::fs::rename(&tmp, &path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn load_canvas(id: &str) -> std::io::Result<Canvas> {
    if !validate_id(id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid canvas id",
        ));
    }
    let path = canvases_dir().join(format!("{id}.json"));
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn list_all() -> Vec<Canvas> {
    let Ok(entries) = std::fs::read_dir(canvases_dir()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(c) = serde_json::from_slice::<Canvas>(&bytes) {
                out.push(c);
            }
        }
    }
    out
}

/// Best-effort thumbnail for the sidebar: the first rendered image/video URL
/// found on any node's `data.result`/`data.output`. Skipped for huge inline
/// `data:` URLs so list responses stay small.
fn thumbnail_of(canvas: &Canvas) -> Option<String> {
    let nodes = canvas.nodes.as_array()?;
    for node in nodes {
        let data = node.get("data")?;
        for key in ["thumbnail", "result", "output", "url"] {
            if let Some(s) = data.get(key).and_then(Value::as_str) {
                if !s.is_empty() && !s.starts_with("data:") {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

fn summary(canvas: &Canvas) -> Value {
    let node_count = canvas.nodes.as_array().map_or(0, Vec::len);
    json!({
        "id": canvas.id,
        "name": canvas.name,
        "node_count": node_count,
        "thumbnail": thumbnail_of(canvas),
        "created_at": canvas.created_at,
        "updated_at": canvas.updated_at,
    })
}

// ── Handlers ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateCanvasBody {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// `GET /api/canvases` — list canvas summaries, newest first.
pub async fn list_canvases() -> Json<Value> {
    let mut canvases = list_all();
    canvases.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let summaries: Vec<Value> = canvases.iter().map(summary).collect();
    Json(json!({ "canvases": summaries }))
}

/// `POST /api/canvases` — create an empty canvas (client may supply an id).
pub async fn create_canvas(Json(body): Json<CreateCanvasBody>) -> (StatusCode, Json<Value>) {
    let id = match body.id {
        Some(id) if validate_id(&id) => id,
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": "invalid canvas id" })),
            );
        }
        None => format!("cnv-{}", chrono::Utc::now().timestamp_millis()),
    };
    let now = now_iso();
    let canvas = Canvas {
        id,
        name: body
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| "Untitled canvas".to_string()),
        nodes: empty_array(),
        edges: empty_array(),
        viewport: None,
        created_at: now.clone(),
        updated_at: now,
    };
    match save_canvas(&canvas) {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "success": true, "canvas": canvas })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `GET /api/canvases/:id` — full board (nodes + edges + viewport).
pub async fn get_canvas(
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<Value>) {
    match load_canvas(&id) {
        Ok(canvas) => (StatusCode::OK, Json(json!({ "canvas": canvas }))),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "canvas not found" })),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct SaveCanvasBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub nodes: Option<Value>,
    #[serde(default)]
    pub edges: Option<Value>,
    #[serde(default)]
    pub viewport: Option<Value>,
}

/// `PUT /api/canvases/:id` — upsert the board. Missing fields are preserved
/// from the existing record (so a name-only rename doesn't wipe the graph).
pub async fn save_canvas_handler(
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SaveCanvasBody>,
) -> (StatusCode, Json<Value>) {
    if !validate_id(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "invalid canvas id" })),
        );
    }
    let existing = load_canvas(&id).ok();
    let created_at = existing
        .as_ref()
        .map(|c| c.created_at.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(now_iso);
    let name = body
        .name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| existing.as_ref().map(|c| c.name.clone()))
        .unwrap_or_else(|| "Untitled canvas".to_string());
    let canvas = Canvas {
        id,
        name,
        nodes: body
            .nodes
            .or_else(|| existing.as_ref().map(|c| c.nodes.clone()))
            .unwrap_or_else(empty_array),
        edges: body
            .edges
            .or_else(|| existing.as_ref().map(|c| c.edges.clone()))
            .unwrap_or_else(empty_array),
        viewport: body.viewport.or_else(|| existing.and_then(|c| c.viewport)),
        created_at,
        updated_at: now_iso(),
    };
    match save_canvas(&canvas) {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "success": true, "canvas": canvas })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `DELETE /api/canvases/:id`.
pub async fn delete_canvas(
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<Value>) {
    if !validate_id(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "invalid canvas id" })),
        );
    }
    let path = canvases_dir().join(format!("{id}.json"));
    match std::fs::remove_file(path) {
        Ok(()) => (StatusCode::OK, Json(json!({ "success": true }))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::OK, Json(json!({ "success": true })))
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}
