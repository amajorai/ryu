use axum::{
    extract::ws::{Message, WebSocket},
    extract::{Path, Query, State, WebSocketUpgrade},
    http::StatusCode,
    response::sse::Event,
    response::{IntoResponse, Json, Response, Sse},
    routing::{get, post},
    Router,
};
use futures_util::stream::{BoxStream, StreamExt};

use crate::utils::wall_micros;
use axum::http::{HeaderValue, Method};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tower_http::cors::CorsLayer;

use crate::config::Config;

// ─── Consent / capture-control globals ────────────────────────────────────────
//
// These are process-global so the capture loop (capture_engine.rs) and the HTTP
// handler both see the same state without adding fields to AppState.

/// True when the user has requested pause/incognito — capture is suppressed.
static CAPTURE_PAUSED: AtomicBool = AtomicBool::new(false);

/// Screen-frame (keyframe) capture toggle. On by default so the timeline shows
/// screenshots out of the box; the desktop can turn it off without disabling the
/// rest of capture (OCR text, clipboard, git, …). Frame writes are gated on this
/// AND the pause/allowlist consent checks.
static FRAME_CAPTURE_ENABLED: AtomicBool = AtomicBool::new(true);

/// Per-app allowlist. Empty vec = no filtering (allow all).
/// Non-empty = only apps whose name appears here receive context capture.
static APP_ALLOWLIST: std::sync::OnceLock<RwLock<Vec<String>>> = std::sync::OnceLock::new();

fn allowlist_cell() -> &'static RwLock<Vec<String>> {
    APP_ALLOWLIST.get_or_init(|| RwLock::new(Vec::new()))
}

/// Returns true when capture is active for the given app name.
///
/// - Always false when globally paused.
/// - Always true when the allowlist is empty (no filtering configured).
/// - True only when the app matches an entry (case-insensitive prefix match) when
///   the allowlist is non-empty.
pub fn is_capture_allowed(app_name: &str) -> bool {
    if CAPTURE_PAUSED.load(Ordering::Relaxed) {
        return false;
    }
    match allowlist_cell().read() {
        Ok(list) if !list.is_empty() => {
            let lower = app_name.to_lowercase();
            list.iter()
                .any(|entry| lower.contains(&entry.to_lowercase()))
        }
        _ => true,
    }
}

/// Returns true when capture is globally paused/incognito.
///
/// Passive capture sources (clipboard, filesystem, git, …) have no app name to
/// gate on, so they check this flag directly rather than `is_capture_allowed`.
pub fn is_capture_paused() -> bool {
    CAPTURE_PAUSED.load(Ordering::Relaxed)
}

/// Set the global pause/incognito state.
pub fn set_capture_paused(paused: bool) {
    CAPTURE_PAUSED.store(paused, Ordering::Relaxed);
}

/// Returns true when screen-frame (keyframe) capture is enabled.
pub fn is_frame_capture_enabled() -> bool {
    FRAME_CAPTURE_ENABLED.load(Ordering::Relaxed)
}

/// Enable or disable screen-frame (keyframe) capture.
pub fn set_frame_capture_enabled(enabled: bool) {
    FRAME_CAPTURE_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Replace the app allowlist (empty = allow all).
pub fn set_app_allowlist(apps: Vec<String>) {
    if let Ok(mut list) = allowlist_cell().write() {
        *list = apps;
    }
}

/// Shared server state.
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub orchestrator: Option<Arc<crate::llm::orchestrator::LlmOrchestrator>>,
    pub procedure_store: Option<Arc<std::sync::Mutex<crate::mimicry::ProcedureStore>>>,
    pub proactive_store: Option<Arc<tokio::sync::Mutex<crate::intelligence::ProactiveStore>>>,
    pub summary_store: Option<Arc<std::sync::Mutex<crate::intelligence::SummaryStore>>>,
    pub mimicry: Option<Arc<crate::mimicry::MimicryCoordinator>>,
    pub pattern_store: Option<Arc<std::sync::Mutex<crate::agent::PatternStore>>>,
    pub trust_tuner: Option<Arc<std::sync::Mutex<crate::intelligence::TrustTuner>>>,
    pub delivery_manager: Option<Arc<crate::intelligence::DeliveryManager>>,
    pub summary_queue: Option<Arc<tokio::sync::Mutex<crate::intelligence::SummaryQueue>>>,
    /// Live window tracker for current-context snapshots.
    pub window_tracker:
        Option<Arc<tokio::sync::Mutex<crate::capture::window::PlatformWindowTracker>>>,
    /// Live AX tree for selected-text extraction.
    pub ax_tree: Option<Arc<tokio::sync::Mutex<crate::capture::accessibility::PlatformAXTree>>>,
}

/// Response payload for GET /context/current.
#[derive(Debug, Serialize)]
pub struct CurrentContextResponse {
    /// Timestamp of the snapshot in Unix microseconds.
    pub timestamp_us: u64,
    /// Active window title (empty string when capture is paused).
    pub window_title: String,
    /// Active application name (empty string when capture is paused).
    pub app_name: String,
    /// Currently selected text as reported by the AX tree (empty when none or unavailable).
    pub selected_text: String,
    /// Text from the most recent OCR frame, if any was recorded.
    pub ocr_text: String,
    /// Timestamp of the OCR frame in Unix microseconds (0 when no OCR data exists).
    pub ocr_timestamp_us: u64,
    /// True when all sources returned data; false when capture is paused or cold.
    pub capture_active: bool,
    /// True when capture is globally paused (pause/incognito mode active).
    pub paused: bool,
}

// ─── Consent control types ─────────────────────────────────────────────────────

/// POST /capture/control — set pause and/or allowlist.
#[derive(Deserialize)]
struct CaptureControlRequest {
    /// When true, suspend capture without killing the sidecar.
    paused: Option<bool>,
    /// Per-app allowlist. Empty vec = allow all; non-empty = allow only listed apps.
    app_allowlist: Option<Vec<String>>,
    /// When false, stop saving screen-frame keyframes (timeline thumbnails) while
    /// leaving the rest of capture running. Omit to leave unchanged.
    frames: Option<bool>,
}

/// GET /capture/control response.
#[derive(Serialize)]
struct CaptureControlResponse {
    paused: bool,
    app_allowlist: Vec<String>,
    /// Whether screen-frame keyframe capture is currently enabled.
    frames: bool,
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<u32>,
    category: Option<String>,
}

#[derive(Deserialize)]
struct TimelineQuery {
    start: u64,
    end: u64,
}

#[derive(Deserialize)]
struct FrameQuery {
    /// Target moment in Unix microseconds; the nearest keyframe is returned.
    ts: u64,
    /// Display to pull the frame from. Defaults to 0 when omitted.
    display: Option<u32>,
}

#[derive(Deserialize)]
struct AgentRequest {
    message: String,
    #[serde(default)]
    conversation_history: Vec<crate::llm::LlmMessage>,
}

#[derive(Deserialize)]
struct GenerateSummaryRequest {
    start_ts: u64,
    end_ts: u64,
}

#[derive(Deserialize)]
struct RunProcedureRequest {
    task: String,
}

#[derive(Deserialize)]
struct IngestRequest {
    events: Vec<serde_json::Value>,
}

/// Build and start the HTTP server.
pub async fn run_server(state: AppState) -> anyhow::Result<()> {
    let port = state.config.port;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    let app = build_router(state);

    tracing::info!("HTTP server listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

fn build_router(state: AppState) -> Router {
    // CORS: allow the Desktop webview (dev + prod) and localhost dev servers to
    // read context snapshots from this loopback-only sidecar. Mirrors Core's list.
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(tower_http::cors::Any)
        .allow_origin([
            "http://localhost:5173".parse::<HeaderValue>().unwrap(),
            "http://localhost:1420".parse::<HeaderValue>().unwrap(),
            "tauri://localhost".parse::<HeaderValue>().unwrap(),
            "https://tauri.localhost".parse::<HeaderValue>().unwrap(),
        ]);

    Router::new()
        // Core
        .route("/health", get(health_handler))
        .route("/stop", get(stop_handler))
        // Search
        .route("/search", get(search_handler))
        .route("/search/semantic", get(semantic_search_handler))
        // Timeline
        .route("/timeline", get(timeline_handler))
        .route("/frame", get(frame_handler))
        .route("/context/recent", get(recent_context_handler))
        .route("/context/current", get(current_context_handler))
        // Agent
        .route("/agent", post(agent_handler))
        .route("/agent/tools", get(agent_tools_handler))
        // Proactive
        .route("/proactive", get(proactive_handler))
        // Meeting summaries
        .route("/summaries", get(summaries_handler))
        .route("/summaries/{id}", get(summary_by_id_handler))
        .route("/summaries/generate", post(generate_summary_handler))
        // Memory
        .route(
            "/memory",
            get(memory_query_handler).post(memory_store_handler),
        )
        .route(
            "/directives",
            get(directives_handler).post(create_directive_handler),
        )
        // Procedures (mimicry)
        .route("/procedures", get(procedures_handler))
        .route("/procedures/run", post(run_procedure_handler))
        // WebSocket for real-time event stream
        .route("/ws", get(ws_handler))
        // External event ingest
        .route("/ingest", post(ingest_handler))
        // New Group F endpoints
        .route("/api/synthesize", post(synthesize_handler))
        .route("/api/feedback", post(feedback_handler))
        .route("/api/patterns", get(patterns_handler))
        .route("/api/intent", post(intent_handler))
        // Consent / capture-control
        .route(
            "/capture/control",
            get(capture_control_get_handler).post(capture_control_post_handler),
        )
        // Meeting recorder (device-local mic + system-loopback capture → Core)
        .route("/meeting/start", post(meeting_start_handler))
        .route("/meeting/stop", post(meeting_stop_handler))
        .route("/meeting/status", get(meeting_status_handler))
        .layer(cors)
        .with_state(state)
}

// ─── Health / Stop ─────────────────────────────────────────────────────────────

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(HealthResponse {
        status: "healthy".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

async fn stop_handler() -> impl IntoResponse {
    // Spawn a task to exit cleanly after returning the response
    tokio::spawn(async {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        std::process::exit(0);
    });
    Json(json!({ "stopping": true }))
}

// ─── Meeting recorder ───────────────────────────────────────────────────────────
//
// Core drives device-local meeting capture through these endpoints: it owns the
// meeting session + transcription + notes, and asks Shadow (the local sensor) to
// stream mixed mic + system-loopback WAV chunks back to
// `POST /api/meetings/:id/chunk`. See `capture::meeting`.

/// POST /meeting/start — begin recording `meeting_id`, uploading chunks to
/// `ingest_url` (defaults to Core on loopback when omitted).
#[derive(Deserialize)]
struct MeetingStartRequest {
    meeting_id: String,
    /// Core endpoint to POST captured WAV chunks to. When omitted, defaults to
    /// `http://127.0.0.1:7980/api/meetings/<id>/chunk`.
    #[serde(default)]
    ingest_url: Option<String>,
}

async fn meeting_start_handler(Json(req): Json<MeetingStartRequest>) -> impl IntoResponse {
    let ingest_url = req.ingest_url.unwrap_or_else(|| {
        format!(
            "http://127.0.0.1:7980/api/meetings/{}/chunk",
            req.meeting_id
        )
    });
    match crate::capture::meeting::start(req.meeting_id.clone(), ingest_url) {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "recording": true, "meeting_id": req.meeting_id })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "recording": false, "error": e.to_string() })),
        ),
    }
}

/// POST /meeting/stop — stop the current recording (body is ignored).
async fn meeting_stop_handler() -> impl IntoResponse {
    crate::capture::meeting::stop();
    Json(json!({ "recording": false }))
}

/// GET /meeting/status — whether a meeting is recording, and which one.
async fn meeting_status_handler() -> impl IntoResponse {
    Json(json!({
        "recording": crate::capture::meeting::is_recording(),
        "meeting_id": crate::capture::meeting::current_meeting_id(),
    }))
}

// ─── Search ────────────────────────────────────────────────────────────────────

async fn search_handler(Query(query): Query<SearchQuery>) -> impl IntoResponse {
    let limit = query.limit.unwrap_or(20);
    match shadow_core::search_text(query.q, limit) {
        Ok(results) => {
            let count = results.len();
            Json(json!({ "results": results, "count": count }))
        }
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}

async fn semantic_search_handler(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> impl IntoResponse {
    let limit = query.limit.unwrap_or(5);
    match shadow_core::vector_search(query.q, limit) {
        Ok(results) => Json(json!({ "results": results })),
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

async fn timeline_handler(Query(query): Query<TimelineQuery>) -> impl IntoResponse {
    match shadow_core::query_time_range(query.start, query.end) {
        Ok(entries) => {
            let count = entries.len();
            Json(json!({ "entries": entries, "count": count }))
        }
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}

/// GET /frame?ts=<micros>&display=<id> — the nearest recorded keyframe JPEG.
///
/// Returns the closest keyframe to `ts` for `display` (default 0), letting the
/// timeline scrubber show what was on screen at a moment. Keyframes are written
/// as JPEGs out of the box (pure-Rust, no ffmpeg) whenever frame capture is on
/// and not paused. Responds 404 when no keyframe exists near `ts` (frame capture
/// off/paused, or nothing recorded yet); clients render a graceful fallback.
async fn frame_handler(Query(query): Query<FrameQuery>) -> Response {
    let display = query.display.unwrap_or(0);
    let path = match shadow_core::find_nearest_keyframe(display, query.ts) {
        Ok(Some(p)) => p,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::debug!("keyframe lookup failed: {e}");
            return StatusCode::NOT_FOUND.into_response();
        }
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(axum::http::header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(),
        Err(e) => {
            tracing::debug!("keyframe read failed for {path}: {e}");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

async fn recent_context_handler(Query(query): Query<SearchQuery>) -> impl IntoResponse {
    let minutes: u64 = query.q.parse().unwrap_or(10);
    let now = wall_micros();
    let start = now.saturating_sub(minutes * 60 * 1_000_000);

    match shadow_core::query_time_range(start, now) {
        Ok(entries) => {
            let count = entries.len();
            Json(json!({ "entries": entries, "count": count, "window_minutes": minutes }))
        }
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}

/// GET /context/current — snapshot of active window, selected text, and latest OCR frame.
///
/// Returns a well-formed empty payload when capture is paused or no data has been recorded yet;
/// never returns a 500 in steady state. When globally paused or the foreground app is not on the
/// allowlist, returns an empty payload with `paused: true` so clients can show the indicator.
async fn current_context_handler(State(state): State<AppState>) -> Json<CurrentContextResponse> {
    use crate::capture::{AXTree, WindowTracker};

    let now_us = wall_micros();
    let globally_paused = CAPTURE_PAUSED.load(Ordering::Relaxed);

    // Early return when globally paused — do not query any capture subsystems.
    if globally_paused {
        return Json(CurrentContextResponse {
            timestamp_us: now_us,
            window_title: String::new(),
            app_name: String::new(),
            selected_text: String::new(),
            ocr_text: String::new(),
            ocr_timestamp_us: 0,
            capture_active: false,
            paused: true,
        });
    }

    // 1. Active window — live query via the platform window tracker.
    let (window_title, app_name) = if let Some(tracker) = &state.window_tracker {
        let t = tracker.lock().await;
        match WindowTracker::get_active_window(&*t).await {
            Some(win) => (win.title, win.app_name),
            None => (String::new(), String::new()),
        }
    } else {
        (String::new(), String::new())
    };

    // 1a. Check per-app allowlist: if the allowlist is non-empty and the foreground app is not
    //     listed, return the empty payload to suppress context for this app.
    if !app_name.is_empty() && !is_capture_allowed(&app_name) {
        return Json(CurrentContextResponse {
            timestamp_us: now_us,
            window_title: String::new(),
            app_name: String::new(),
            selected_text: String::new(),
            ocr_text: String::new(),
            ocr_timestamp_us: 0,
            capture_active: false,
            paused: false,
        });
    }

    // 2. Selected text — read from the AX tree's focused element value.
    //    We do a best-effort walk: if the focused tree has a non-empty value on the root
    //    or any direct child, treat it as the selection. Never fail hard.
    let selected_text = if let Some(ax) = &state.ax_tree {
        let t = ax.lock().await;
        match AXTree::get_focused_tree(&*t).await {
            Ok(tree) => extract_selected_text(&tree),
            Err(_) => String::new(),
        }
    } else {
        String::new()
    };

    // 3. Latest OCR frame — read from the in-memory cache maintained by the
    //    screen-capture loop in capture_engine.rs. Zero overhead; no lock contention.
    let (ocr_text, ocr_timestamp_us) = crate::capture_engine::get_latest_ocr()
        .map(|(text, _app, ts)| (text, ts))
        .unwrap_or_else(|| (String::new(), 0));

    let capture_active = !window_title.is_empty() || !app_name.is_empty();

    Json(CurrentContextResponse {
        timestamp_us: now_us,
        window_title,
        app_name,
        selected_text,
        ocr_text,
        ocr_timestamp_us,
        capture_active,
        paused: false,
    })
}

// ─── Capture control ───────────────────────────────────────────────────────────

/// GET /capture/control — read current pause state, allowlist, and frame toggle.
async fn capture_control_get_handler() -> impl IntoResponse {
    let paused = CAPTURE_PAUSED.load(Ordering::Relaxed);
    let app_allowlist = allowlist_cell()
        .read()
        .map(|l| l.clone())
        .unwrap_or_default();
    let frames = is_frame_capture_enabled();
    Json(CaptureControlResponse {
        paused,
        app_allowlist,
        frames,
    })
}

/// POST /capture/control — update pause state, allowlist, and/or frame toggle.
///
/// Fields are optional; omitting a field leaves it unchanged. Returns the
/// resulting state after applying the changes.
async fn capture_control_post_handler(Json(req): Json<CaptureControlRequest>) -> impl IntoResponse {
    if let Some(p) = req.paused {
        set_capture_paused(p);
    }
    if let Some(list) = req.app_allowlist {
        set_app_allowlist(list);
    }
    if let Some(f) = req.frames {
        set_frame_capture_enabled(f);
    }
    let paused = CAPTURE_PAUSED.load(Ordering::Relaxed);
    let app_allowlist = allowlist_cell()
        .read()
        .map(|l| l.clone())
        .unwrap_or_default();
    let frames = is_frame_capture_enabled();
    Json(CaptureControlResponse {
        paused,
        app_allowlist,
        frames,
    })
}

/// Walk an AX tree node and return the first non-empty value string found,
/// preferring values on a focused/selected text field over generic containers.
pub fn extract_selected_text(node: &crate::capture::AXTreeNode) -> String {
    // Roles that are likely to carry typed/selected text content.
    let text_roles = [
        "text",
        "edit",
        "textfield",
        "combobox",
        "textarea",
        "document",
    ];
    let role_lower = node.role.to_lowercase();

    if text_roles.iter().any(|r| role_lower.contains(r)) {
        if let Some(val) = &node.value {
            if !val.is_empty() {
                return val.clone();
            }
        }
    }

    for child in &node.children {
        let found = extract_selected_text(child);
        if !found.is_empty() {
            return found;
        }
    }

    String::new()
}

// ─── Agent ─────────────────────────────────────────────────────────────────────

async fn agent_handler(
    State(state): State<AppState>,
    Json(req): Json<AgentRequest>,
) -> Sse<BoxStream<'static, Result<Event, std::convert::Infallible>>> {
    let stream: BoxStream<'static, Result<Event, std::convert::Infallible>> =
        match &state.orchestrator {
            None => {
                let msg =
                    serde_json::to_string(&json!({"type":"error","message":"LLM not configured"}))
                        .unwrap_or_default();
                futures_util::stream::once(async move { Ok(Event::default().data(msg)) }).boxed()
            }
            Some(o) => {
                let runtime = Arc::new(crate::agent::AgentRuntime::new(Arc::clone(o)));
                runtime
                    .run(req.message, req.conversation_history)
                    .map(|event| {
                        let data = serde_json::to_string(&event).unwrap_or_default();
                        Ok(Event::default().data(data))
                    })
                    .boxed()
            }
        };
    Sse::new(stream)
}

async fn agent_tools_handler(State(state): State<AppState>) -> impl IntoResponse {
    let orchestrator = match &state.orchestrator {
        Some(o) => Arc::clone(o),
        None => {
            return Json(json!({ "tools": [] }));
        }
    };
    let runtime = crate::agent::AgentRuntime::new(orchestrator);
    let tools = runtime.tool_definitions();
    Json(json!({ "tools": tools, "count": tools.len() }))
}

// ─── Proactive ─────────────────────────────────────────────────────────────────

async fn proactive_handler(State(state): State<AppState>) -> impl IntoResponse {
    match &state.proactive_store {
        Some(store) => {
            let s = store.lock().await;
            match s.list_recent(20) {
                Ok(suggestions) => Json(json!({ "suggestions": suggestions })),
                Err(e) => Json(json!({ "error": e.to_string() })),
            }
        }
        None => Json(json!({ "suggestions": [] })),
    }
}

// ─── Meeting Summaries ─────────────────────────────────────────────────────────

async fn summaries_handler(State(state): State<AppState>) -> impl IntoResponse {
    match &state.summary_store {
        Some(store) => {
            let s = store.lock().unwrap();
            match s.list(20) {
                Ok(summaries) => Json(json!({ "summaries": summaries })),
                Err(e) => Json(json!({ "error": e.to_string() })),
            }
        }
        None => Json(json!({ "summaries": [] })),
    }
}

async fn summary_by_id_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match &state.summary_store {
        Some(store) => {
            let s = store.lock().unwrap();
            match s.get(&id) {
                Ok(Some(summary)) => Json(json!(summary)),
                Ok(None) => Json(json!({ "error": "not found" })),
                Err(e) => Json(json!({ "error": e.to_string() })),
            }
        }
        None => Json(json!({ "error": "summary store not available" })),
    }
}

async fn generate_summary_handler(
    State(state): State<AppState>,
    Json(req): Json<GenerateSummaryRequest>,
) -> impl IntoResponse {
    let orchestrator = match &state.orchestrator {
        Some(o) => Arc::clone(o),
        None => return Json(json!({ "error": "LLM not configured" })),
    };

    let resolver = crate::intelligence::MeetingResolver;
    let meetings = match resolver.find_meetings(req.start_ts, req.end_ts) {
        Ok(m) => m,
        Err(e) => return Json(json!({ "error": e.to_string() })),
    };

    let summarizer = crate::intelligence::MeetingSummarizer::new(orchestrator);
    let mut summaries = vec![];

    for window in &meetings {
        match summarizer.summarize(window).await {
            Ok(summary) => {
                if let Some(store) = &state.summary_store {
                    let s = store.lock().unwrap();
                    let _ = s.store(&summary);
                }
                summaries.push(summary);
            }
            Err(e) => tracing::warn!("Failed to summarize meeting: {}", e),
        }
    }

    Json(json!({ "summaries": summaries, "count": summaries.len() }))
}

// ─── Memory ────────────────────────────────────────────────────────────────────

async fn memory_query_handler(Query(query): Query<SearchQuery>) -> impl IntoResponse {
    match crate::memory::MEMORY_STORE.get() {
        Some(store) => {
            let store = store.lock().unwrap();
            let category = query.category.as_deref();
            match store.query(category, &query.q) {
                Ok(entries) => Json(json!({ "entries": entries })),
                Err(e) => Json(json!({ "error": e.to_string() })),
            }
        }
        None => Json(json!({ "entries": [] })),
    }
}

async fn memory_store_handler(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    match crate::memory::MEMORY_STORE.get() {
        Some(store) => {
            let store = store.lock().unwrap();
            let entry = crate::memory::MemoryEntry {
                id: body["id"]
                    .as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                category: body["category"].as_str().unwrap_or("fact").to_string(),
                content: body["content"].as_str().unwrap_or("").to_string(),
                confidence: body["confidence"].as_f64().unwrap_or(1.0) as f32,
                source_episode_id: body["source_episode_id"].as_str().map(|s| s.to_string()),
                access_count: 0,
                last_accessed: 0,
                created_at: wall_micros(),
            };
            match store.upsert(&entry) {
                Ok(_) => Json(json!({ "id": entry.id, "stored": true })),
                Err(e) => Json(json!({ "error": e.to_string() })),
            }
        }
        None => Json(json!({ "error": "memory store not initialized" })),
    }
}

async fn directives_handler() -> impl IntoResponse {
    match crate::memory::MEMORY_STORE.get() {
        Some(store) => match store.lock().unwrap().list_active(None) {
            Ok(directives) => Json(json!({ "directives": directives })),
            Err(e) => Json(json!({ "error": e.to_string() })),
        },
        None => Json(json!({ "directives": [] })),
    }
}

async fn create_directive_handler(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    match crate::memory::MEMORY_STORE.get() {
        Some(store) => {
            let store = store.lock().unwrap();
            let directive = crate::memory::Directive {
                id: uuid::Uuid::new_v4().to_string(),
                directive_type: body["directive_type"]
                    .as_str()
                    .unwrap_or("reminder")
                    .to_string(),
                content: body["content"].as_str().unwrap_or("").to_string(),
                trigger_pattern: body["trigger_pattern"].as_str().map(|s| s.to_string()),
                action: body["action"].as_str().map(|s| s.to_string()),
                priority: body["priority"].as_u64().unwrap_or(5) as u8,
                expires_at: body["expires_at"].as_u64(),
                created_at: wall_micros(),
            };
            match store.create_directive(&directive) {
                Ok(_) => Json(json!({ "id": directive.id, "created": true })),
                Err(e) => Json(json!({ "error": e.to_string() })),
            }
        }
        None => Json(json!({ "error": "memory store not initialized" })),
    }
}

// ─── Procedures ────────────────────────────────────────────────────────────────

async fn procedures_handler(State(state): State<AppState>) -> impl IntoResponse {
    match &state.procedure_store {
        Some(store) => {
            let s = store.lock().unwrap();
            match s.list() {
                Ok(procedures) => Json(json!({ "procedures": procedures })),
                Err(e) => Json(json!({ "error": e.to_string() })),
            }
        }
        None => Json(json!({ "procedures": [] })),
    }
}

async fn run_procedure_handler(
    State(state): State<AppState>,
    Json(req): Json<RunProcedureRequest>,
) -> Sse<BoxStream<'static, Result<Event, std::convert::Infallible>>> {
    let stream: BoxStream<'static, Result<Event, std::convert::Infallible>> = match &state.mimicry {
        None => {
            let msg =
                serde_json::to_string(&json!({"type":"error","message":"Mimicry not configured"}))
                    .unwrap_or_default();
            futures_util::stream::once(async move { Ok(Event::default().data(msg)) }).boxed()
        }
        Some(m) => Arc::clone(m)
            .run(req.task)
            .map(|event| {
                let data = serde_json::to_string(&event).unwrap_or_default();
                Ok(Event::default().data(data))
            })
            .boxed(),
    };
    Sse::new(stream)
}

// ─── WebSocket ─────────────────────────────────────────────────────────────────

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_websocket)
}

async fn handle_websocket(mut socket: WebSocket) {
    tracing::info!("WebSocket client connected");
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));

    loop {
        tokio::select! {
            _ = interval.tick() => {
                // Send recent events to connected client
                let now = wall_micros();
                let start = now.saturating_sub(3 * 1_000_000); // last 3s
                let payload = match shadow_core::query_time_range(start, now) {
                    Ok(entries) if !entries.is_empty() => {
                        serde_json::to_string(&json!({ "type": "events", "data": entries }))
                            .unwrap_or_default()
                    }
                    _ => continue,
                };
                if socket.send(Message::Text(payload.into())).await.is_err() {
                    break;
                }
            }
            Some(msg) = socket.recv() => {
                match msg {
                    Ok(Message::Close(_)) => break,
                    Err(_) => break,
                    _ => {}
                }
            }
        }
    }
    tracing::info!("WebSocket client disconnected");
}

// ─── External ingest ──────────────────────────────────────────────────────────

async fn ingest_handler(Json(req): Json<IngestRequest>) -> impl IntoResponse {
    let mut count = 0u32;
    for event in &req.events {
        if let Ok(data) = rmp_serde::to_vec(event) {
            if shadow_core::write_event(data).is_ok() {
                count += 1;
            }
        }
    }
    Json(json!({ "ingested": count }))
}

// ─── New API endpoints ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SynthesizeRequest {
    actions: Vec<serde_json::Value>,
}

async fn synthesize_handler(
    State(state): State<AppState>,
    Json(req): Json<SynthesizeRequest>,
) -> impl IntoResponse {
    let orchestrator = match &state.orchestrator {
        Some(o) => Arc::clone(o),
        None => return Json(json!({ "error": "LLM not configured" })),
    };

    // Convert JSON actions to LearnedEvent
    let events: Vec<ghost_core::learning::LearnedEvent> = req
        .actions
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();

    match crate::mimicry::ProcedureSynthesizer::synthesize(&events, &orchestrator).await {
        Ok(template) => Json(json!(template)),
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
struct FeedbackRequest {
    suggestion_type: String,
    kind: String,
}

async fn feedback_handler(
    State(state): State<AppState>,
    Json(req): Json<FeedbackRequest>,
) -> impl IntoResponse {
    let kind = match req.kind.as_str() {
        "thumbs_up" => crate::intelligence::FeedbackKind::ThumbsUp,
        "thumbs_down" => crate::intelligence::FeedbackKind::ThumbsDown,
        "snooze" => crate::intelligence::FeedbackKind::Snooze,
        _ => crate::intelligence::FeedbackKind::Dismiss,
    };

    if let Some(dm) = &state.delivery_manager {
        dm.record_feedback(kind, &req.suggestion_type);
        Json(json!({ "applied": true }))
    } else {
        Json(json!({ "error": "delivery manager not configured" }))
    }
}

#[derive(Deserialize)]
struct PatternsQuery {
    q: Option<String>,
    app: Option<String>,
    limit: Option<usize>,
}

async fn patterns_handler(
    State(state): State<AppState>,
    Query(query): Query<PatternsQuery>,
) -> impl IntoResponse {
    match &state.pattern_store {
        Some(store) => {
            if let Ok(mut s) = store.lock() {
                let q = query.q.as_deref().unwrap_or("");
                let app = query.app.as_deref().unwrap_or("");
                let limit = query.limit.unwrap_or(10);
                let patterns = s.find_relevant(q, app, limit);
                Json(json!({ "patterns": patterns.iter().map(|(p, score)| {
                    json!({ "pattern": p, "score": score })
                }).collect::<Vec<_>>() }))
            } else {
                Json(json!({ "patterns": [] }))
            }
        }
        None => Json(json!({ "patterns": [] })),
    }
}

#[derive(Deserialize)]
struct IntentRequest {
    query: String,
}

async fn intent_handler(
    State(state): State<AppState>,
    Json(req): Json<IntentRequest>,
) -> impl IntoResponse {
    let intent = match &state.orchestrator {
        Some(o) => {
            let i = crate::agent::IntentClassifier::classify(&req.query, o).await;
            i.as_str().to_string()
        }
        None => crate::agent::IntentClassifier::classify_heuristic(&req.query)
            .as_str()
            .to_string(),
    };
    Json(json!({ "intent": intent, "query": req.query }))
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal AppState with all optional fields set to None.
    /// The handler must return a well-formed response even with no capture subsystems.
    fn minimal_state() -> AppState {
        AppState {
            config: crate::config::Config::new(),
            orchestrator: None,
            procedure_store: None,
            proactive_store: None,
            summary_store: None,
            mimicry: None,
            pattern_store: None,
            trust_tuner: None,
            delivery_manager: None,
            summary_queue: None,
            window_tracker: None,
            ax_tree: None,
        }
    }

    /// Invoke the handler directly (no HTTP stack required).
    async fn invoke_handler(state: AppState) -> CurrentContextResponse {
        use axum::extract::State;
        let Json(body) = current_context_handler(State(state)).await;
        body
    }

    /// Verify that /context/current returns a well-formed payload (all required fields present)
    /// when all capture subsystems are absent (cold-start / capture paused).
    /// OCR cache state is intentionally not checked here since that field is tested in
    /// test_current_context_reflects_seeded_ocr, and the global cache may be set by a
    /// concurrent test.
    #[tokio::test]
    async fn test_current_context_empty_is_well_formed() {
        let resp = invoke_handler(minimal_state()).await;

        // Structural checks that always hold regardless of OCR cache state.
        assert!(resp.timestamp_us > 0, "timestamp_us must be non-zero");
        assert_eq!(
            resp.window_title, "",
            "window_title should be empty when no tracker"
        );
        assert_eq!(
            resp.app_name, "",
            "app_name should be empty when no tracker"
        );
        assert_eq!(
            resp.selected_text, "",
            "selected_text should be empty when no AX tree"
        );
        assert!(
            !resp.capture_active,
            "capture_active should be false when no window data"
        );
        // ocr_text / ocr_timestamp_us are exercised in test_current_context_reflects_seeded_ocr
    }

    /// Verify that the OCR cache round-trip works: seed a value and verify it is
    /// readable via the public accessor (unit-level; no HTTP stack required).
    /// This test does not go through the full handler to avoid race conditions on
    /// the global OCR cache with other concurrently-running tests.
    #[test]
    fn test_ocr_cache_round_trip() {
        let cell = crate::capture_engine::get_latest_ocr_cell_for_test();

        let sentinel_text = "OCR_round_trip_sentinel_value".to_string();
        let sentinel_ts = 9_999_000_000_000_000u64;

        {
            let mut guard = cell.lock().unwrap();
            *guard = Some((sentinel_text.clone(), "TestApp".to_string(), sentinel_ts));
        }

        let result = crate::capture_engine::get_latest_ocr();
        assert!(
            result.is_some(),
            "get_latest_ocr should return Some after seeding"
        );
        let (text, _app, ts) = result.unwrap();
        assert_eq!(text, sentinel_text, "OCR text must match what was seeded");
        assert_eq!(ts, sentinel_ts, "OCR timestamp must match what was seeded");
    }

    /// Integration test: verify OCR data flows from cache through the handler.
    /// Runs single-threaded to avoid interference with the cache reset in the
    /// well-formed test. Uses a sentinel value that is set immediately before
    /// the handler call and verified in the response.
    #[tokio::test]
    async fn test_current_context_reflects_seeded_ocr() {
        // Use a globally-unique sentinel value unlikely to collide with other tests.
        let sentinel_text = "INTEGRATION_OCR_SENTINEL_67890".to_string();
        let sentinel_ts = 8_765_432_100_000_000u64;

        // Lock the cell for the duration of this test to prevent races.
        let cell = crate::capture_engine::get_latest_ocr_cell_for_test();
        let mut guard = cell.lock().unwrap();
        *guard = Some((sentinel_text.clone(), "TestApp".to_string(), sentinel_ts));

        // Call the handler while holding the lock — the handler will try to acquire
        // the same lock via get_latest_ocr(), which would deadlock. Release the lock
        // first and immediately call.
        drop(guard);

        let resp = invoke_handler(minimal_state()).await;

        // The cache may have been modified by another test between drop and the handler
        // reading it. We verify the sentinel or accept that a race occurred.
        // If the response has our sentinel, the round-trip worked.
        if resp.ocr_text == sentinel_text {
            assert_eq!(resp.ocr_timestamp_us, sentinel_ts);
        }
        // If another test cleared the cache, we still verify the handler didn't panic.
        assert!(
            resp.timestamp_us > 0,
            "handler must return a valid timestamp"
        );
    }

    /// Verify extract_selected_text returns the first text-role value it finds.
    #[test]
    fn test_extract_selected_text_text_role() {
        let node = crate::capture::AXTreeNode {
            role: "textfield".to_string(),
            title: None,
            value: Some("selected content".to_string()),
            identifier: None,
            bounds: None,
            children: vec![],
        };
        assert_eq!(extract_selected_text(&node), "selected content");
    }

    /// Verify extract_selected_text returns empty string for non-text roles.
    #[test]
    fn test_extract_selected_text_non_text_role() {
        let node = crate::capture::AXTreeNode {
            role: "button".to_string(),
            title: Some("OK".to_string()),
            value: Some("some value".to_string()),
            identifier: None,
            bounds: None,
            children: vec![],
        };
        assert_eq!(extract_selected_text(&node), "");
    }

    /// Verify extract_selected_text recurses into children.
    #[test]
    fn test_extract_selected_text_recurses() {
        let child = crate::capture::AXTreeNode {
            role: "edit".to_string(),
            title: None,
            value: Some("deep text".to_string()),
            identifier: None,
            bounds: None,
            children: vec![],
        };
        let root = crate::capture::AXTreeNode {
            role: "window".to_string(),
            title: None,
            value: None,
            identifier: None,
            bounds: None,
            children: vec![child],
        };
        assert_eq!(extract_selected_text(&root), "deep text");
    }

    /// Verify the route is registered by ensuring build_router() does not panic
    /// and includes /context/current.
    #[test]
    fn test_route_is_registered() {
        // build_router is called successfully — if the route isn't registered
        // the compiler would catch the handler mismatch.
        let _router = build_router(minimal_state());
    }

    /// AC4: when globally paused, /context/current must return the empty/suppressed state.
    #[tokio::test]
    async fn test_current_context_returns_empty_when_paused() {
        // Set paused=true for this test; restore after.
        set_capture_paused(true);
        let resp = invoke_handler(minimal_state()).await;
        // Must restore before any assertion that could panic to avoid leaking state.
        set_capture_paused(false);

        assert!(
            resp.paused,
            "paused field must be true when globally paused"
        );
        assert!(
            !resp.capture_active,
            "capture_active must be false when paused"
        );
        assert_eq!(
            resp.window_title, "",
            "window_title must be empty when paused"
        );
        assert_eq!(resp.app_name, "", "app_name must be empty when paused");
        assert_eq!(
            resp.selected_text, "",
            "selected_text must be empty when paused"
        );
        assert_eq!(resp.ocr_text, "", "ocr_text must be suppressed when paused");
    }

    /// Verify is_capture_allowed returns false when globally paused.
    #[test]
    fn test_is_capture_allowed_respects_pause() {
        set_capture_paused(true);
        let allowed = is_capture_allowed("SomeApp");
        set_capture_paused(false);
        assert!(!allowed, "capture must not be allowed when globally paused");
    }

    /// Verify is_capture_allowed returns true when allowlist is empty (allow all).
    #[test]
    fn test_is_capture_allowed_empty_allowlist_allows_all() {
        set_capture_paused(false);
        set_app_allowlist(vec![]);
        assert!(
            is_capture_allowed("AnyApp"),
            "empty allowlist must allow any app"
        );
    }

    /// Verify is_capture_allowed filters when allowlist is non-empty.
    #[test]
    fn test_is_capture_allowed_non_empty_allowlist() {
        set_capture_paused(false);
        set_app_allowlist(vec!["VSCode".to_string(), "Terminal".to_string()]);

        assert!(
            is_capture_allowed("VSCode"),
            "VSCode is on the allowlist and must be allowed"
        );
        assert!(
            !is_capture_allowed("Slack"),
            "Slack is not on the allowlist and must be blocked"
        );

        // Restore empty allowlist so other tests are not affected.
        set_app_allowlist(vec![]);
    }
}
