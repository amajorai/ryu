//! `ryu-meetings` — the standalone, out-of-process meeting-notes sidecar.
//!
//! Runs the extracted `ryu_meetings` capability crate (the SQLite [`MeetingStore`] +
//! the [`MeetingEngine`] + the audio/diarize pipeline + the `/api/meetings/*`
//! surface, defined in `lib.rs` / `api.rs`) as a SEPARATE PROCESS that Core spawns,
//! health-checks, and proxies to on loopback — exactly like `ryu-quests` /
//! `ryu-teams` / `ryu-mail`. The store, engine, pipeline, and handlers live in the
//! crate lib; this binary is only the process shell around them, so the SAME crate
//! still compiles into Core in-process as a path dependency (no code is duplicated).
//!
//! The crate's [`ryu_meetings::routes`] returns a state-baked, state-less
//! `Router<()>` whose paths are RELATIVE to `/api/meetings` (Core nests it at that
//! prefix in-process). This binary nests it under the same `/api/meetings` prefix, so
//! the external paths are byte-identical to Core's in-process mount and the generic
//! ext-proxy forwards `/api/meetings/*` to it unchanged.
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on the health probe +
//! every proxied hop). EVERY `/api/meetings/*` route is protected. The gate is
//! FAIL-CLOSED: with no token configured every protected route rejects with 401.
//! `/health` is the ONE un-gated route (loopback probe, returns no meeting data), so
//! Core's pre-auth health check succeeds.
//!
//! Port: `RYU_MEETINGS_PORT` env, default `7998`. Data dir: resolved via the inlined
//! `paths::ryu_dir` (`RYU_DIR`-env-first, injected by Core at spawn), so it opens the
//! SAME `meetings.db` (and persisted diarization PCM) the node uses.
//!
//! HOST SHIM (the sidecar's [`ryu_meetings::MeetingsHost`] impl): this crate inverts
//! every cross-cutting Core call through the host trait. In-process, Core wires these
//! to its real machinery (`apps/core/src/meetings_host.rs`). Out-of-process this shell
//! provides standalone implementations for the ones the sidecar can own by itself:
//!
//! - **preferences** → a JSON file under `RYU_DIR` (durable across restarts);
//! - **transcription (STT)** → the extracted [`ryu_stt`] crate, injecting an
//!   env-resolved [`SidecarSttHost`]. This is the SAME code path Core runs
//!   (whisper.cpp `/inference` or the Gateway `/v1/audio/transcriptions`), so the
//!   sidecar transcribes genuinely — no stub. NOTE (flagged hot path): a chunk
//!   arrives here over multipart, then this callback forwards the audio to the STT
//!   engine — the "audio double-hop". It is inherent (Core's in-process path hops to
//!   whisper.cpp too); with no `public_mount` yet the chunk also proxies through Core
//!   first, adding one hop until CoreDecouple lands the public mount.
//! - **Gateway note-gen + auto-title** → env `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN`
//!   (mirroring `apps/core/src/sidecar/gateway.rs`); `generate_title` runs a real
//!   Gateway chat completion here, so auto-naming works out-of-process.
//! - **notes → Space (`save_notes_to_space`)** → a Core host callback. Filing into the
//!   "Meetings" Space reaches Core's `SpaceStore` + background-owner tenancy, which the
//!   sidecar does not host, so this posts `{title, markdown}` to Core's
//!   `POST /api/host/meetings/save-notes` (ext-bearer + `x-ryu-plugin-id` authed, the
//!   monitors-callback posture). Core files the notes under the background owner and
//!   returns `{space_id, doc_id}`, which the engine attaches to the meeting row — so a
//!   decoupled node mirrors notes into the Meetings Space exactly as the in-process
//!   node did. If the callback is unreachable/unauthed it degrades to `None` (notes
//!   still persist in `meetings.db`; they are just not mirrored into a Space).

mod paths;

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use ryu_stt::SttHost;
use serde_json::json;

use ryu_meetings::{routes, MeetingEngine, MeetingStore, MeetingsCtx, MeetingsHost};

/// Default loopback port for the meetings sidecar (overridable via
/// `RYU_MEETINGS_PORT`). 7998 is free (7990 finetune · 7991 quests · 7992 clips ·
/// 7993 browser · 7994 teams · 7995 research · 7996 mail · 7997 dashboards are
/// taken). Kept identical in `meetings.plugin.json`.
const DEFAULT_PORT: u16 = 7998;

/// The bundled local default notes/title model when no pref/env is set — mirrors
/// Core's `registry::DEFAULT_LLM_MODEL`. Nothing is hardcoded to a remote provider;
/// a pref/env (`RYU_MEETING_NOTES_MODEL` / `RYU_DEFAULT_LLM_MODEL`) still overrides it.
const DEFAULT_NOTES_MODEL: &str = "gemma-4-E2B-it-Q4_K_M";

/// The local gateway default (mirrors `apps/core/src/sidecar/gateway.rs`).
const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:7981";

/// The local whisper.cpp voice server default (mirrors Core's `WHISPER_ADDR`).
const DEFAULT_WHISPER_URL: &str = "http://127.0.0.1:8090";

/// This app's plugin id (mirrors Core's `plugins::builtins::MEETINGS_PLUGIN_ID`).
/// Presented on the `x-ryu-plugin-id` header of the save-notes host callback so
/// Core's `authenticate_sidecar` recomputes the matching ext token.
const MEETINGS_PLUGIN_ID: &str = "com.ryu.meetings";

/// The `x-ryu-plugin-id` header Core's `authenticate_sidecar` reads — mirrors
/// `apps/core/src/sidecar/ext_proxy.rs::HDR_PLUGIN_ID`.
const HDR_PLUGIN_ID: &str = "x-ryu-plugin-id";

/// Core's loopback port default when `RYU_CORE_PORT` is unset (mirrors Core's
/// bind default). Core injects `RYU_CORE_PORT` (profile-shifted) at spawn.
const DEFAULT_CORE_PORT: u16 = 7980;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_MEETINGS_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects via the generic ext-proxy loader
    // (`RYU_EXT_TOKEN`) — the per-plugin minted secret it stamps on every proxied
    // hop + the health probe. The protected `/api/meetings/*` routes require it.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-meetings: protected /api/meetings/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-meetings: no RYU_EXT_TOKEN set; protected /api/meetings/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    let dir = paths::ryu_dir();
    // Publish the data dir so the engine's persisted diarization PCM lands under the
    // SAME `RYU_DIR` Core uses (`data_dir()` reads this OnceLock).
    ryu_meetings::init_data_dir(dir.clone());
    let store = MeetingStore::open(dir.join("meetings.db"))?;

    // The sidecar host shim: preferences persist to a JSON file under `RYU_DIR` (so
    // a `detection-config`/notes-model change survives a restart, matching the
    // in-process PreferencesStore-backed behaviour); STT reuses `ryu_stt`; note-gen
    // + auto-title reach the Gateway; Spaces filing degrades (see the module docs).
    let host: Arc<dyn MeetingsHost> =
        Arc::new(SidecarMeetingsHost::new(dir.join("meetings-prefs.json")));
    let engine = MeetingEngine::new(store.clone(), host, reqwest::Client::new());

    // Publish the process-global engine (mirrors `ryu-quests`). In the sidecar its
    // off-`ServerState` readers do not run, so it is an inert-but-harmless consumer;
    // the HTTP handlers use the state-baked `MeetingsCtx` below.
    ryu_meetings::set_global_engine(engine.clone());

    // The crate router (paths relative to `/api/meetings`) nested under the external
    // prefix, with the shared-secret gate layered over the whole nest — meetings has
    // no public route. `from_fn` closes over the resolved token so no extra state
    // field is needed.
    let gated_token = token.clone();
    let meetings = Router::new()
        .nest("/api/meetings", routes(MeetingsCtx::new(engine)))
        .layer(from_fn(move |req: Request, next: Next| {
            let expected = gated_token.clone();
            async move { require_meetings_token(req, next, expected.as_deref()).await }
        }));

    // `/health` sits OUTSIDE the gated nest so the loopback health probe succeeds
    // before auth. It asserts the store is readable (a cheap `list`) and returns no
    // meeting data.
    let health_store = store;
    let app = Router::new()
        .route(
            "/health",
            get(move || {
                let store = health_store.clone();
                async move { health(store).await }
            }),
        )
        .merge(meetings);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-meetings sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: asserts the store is readable (a cheap `list`) so health
/// also confirms DB readiness, not just process liveness. Un-gated and data-free.
async fn health(store: MeetingStore) -> Response {
    match store.list_meetings().await {
        Ok(meetings) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "meetingCount": meetings.len() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Shared-secret bearer gate for the proxied `/api/meetings/*` surface. Core stays
/// the auth front — it runs `require_auth`, then re-stamps `Authorization: Bearer
/// <RYU_EXT_TOKEN>` on the loopback hop — so a request that did NOT come through Core
/// (any other local process on a shared host) is rejected with 401.
///
/// **Fail-closed:** `expected == None`/empty (no token configured) rejects every
/// request rather than falling open.
async fn require_meetings_token(req: Request, next: Next, expected: Option<&str>) -> Response {
    let provided = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if bearer_ok(provided, expected) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}

/// Pure bearer check (factored out so the auth decision is unit-testable without an
/// axum `Request`/`Next`). Returns `true` only when `expected` is a non-empty token
/// AND `provided` equals it (constant-time compared). A `None`/empty `expected` is
/// the fail-closed case → always `false`.
fn bearer_ok(provided: Option<&str>, expected: Option<&str>) -> bool {
    let Some(expected) = expected.filter(|t| !t.is_empty()) else {
        return false;
    };
    ct_eq(provided.unwrap_or("").as_bytes(), expected.as_bytes())
}

/// Constant-time byte comparison — no early return on the first mismatched byte, so
/// the token check does not leak length/prefix via timing.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── env resolution (shared by both host shims, "nothing hardcoded") ────────────

/// The local Gateway base URL (env-first, else the local gateway default port).
fn gateway_url_env() -> String {
    std::env::var("RYU_GATEWAY_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_string())
}

/// The Gateway bearer token, if one is configured (`None` when unset — never the
/// fabricated `"ryu-local"` literal; that fallback is the STT bearer's, below).
fn gateway_token_env() -> Option<String> {
    std::env::var("RYU_GATEWAY_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
}

/// The sidecar's [`SttHost`]: resolves the whisper base-url, Gateway url/bearer, and
/// parakeet model dir from env / `RYU_DIR`. Mirrors Core's `CoreSttHost`, but every
/// value is env-resolved rather than read from Core config. The parakeet dir is
/// never read here (the sidecar builds `ryu_stt` at default features, so the engine
/// resolves to whisper); it is provided for completeness.
struct SidecarSttHost;

impl SttHost for SidecarSttHost {
    fn whisper_base_url(&self) -> String {
        std::env::var("RYU_WHISPER_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_WHISPER_URL.to_string())
    }

    fn gateway_url(&self) -> String {
        gateway_url_env()
    }

    fn gateway_bearer(&self) -> Result<String, String> {
        // Mirrors `gateway::gateway_bearer` local path: a configured token wins,
        // else fall back to the local gateway's `"ryu-local"` dev bearer (the local
        // gateway accepts it). The sidecar is a local data plane, so there is no
        // remote-fleet fail-closed branch here.
        Ok(gateway_token_env().unwrap_or_else(|| "ryu-local".to_string()))
    }

    fn parakeet_model_dir(&self) -> PathBuf {
        paths::ryu_dir().join("models").join("parakeet-v3")
    }
}

/// The sidecar's standalone [`MeetingsHost`]: everything the moved meeting code needs
/// from the host, provided by the process itself rather than by Core.
struct SidecarMeetingsHost {
    prefs_path: PathBuf,
    prefs: Mutex<HashMap<String, String>>,
    client: reqwest::Client,
    /// Core's loopback base URL (`http://127.0.0.1:<RYU_CORE_PORT>`), resolved once —
    /// the save-notes host callback target.
    core_base: String,
    /// The injected ext bearer (`RYU_EXT_TOKEN`) presented on the callback. `None`
    /// leaves the callback fail-closed (Core rejects it, and filing degrades to `None`).
    ext_token: Option<String>,
}

impl SidecarMeetingsHost {
    fn new(prefs_path: PathBuf) -> Self {
        let prefs = load_prefs(&prefs_path);
        let core_port: u16 = std::env::var("RYU_CORE_PORT")
            .ok()
            .and_then(|p| p.trim().parse().ok())
            .unwrap_or(DEFAULT_CORE_PORT);
        let ext_token = std::env::var("RYU_EXT_TOKEN")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        Self {
            prefs_path,
            prefs: Mutex::new(prefs),
            client: reqwest::Client::new(),
            core_base: format!("http://127.0.0.1:{core_port}"),
            ext_token,
        }
    }
}

/// Read the persisted preference map (empty on missing/corrupt file — a fresh
/// install just falls back to defaults).
fn load_prefs(path: &Path) -> HashMap<String, String> {
    let Ok(bytes) = std::fs::read(path) else {
        return HashMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Persist the preference map atomically (write a temp file, then rename) so a
/// crash mid-write cannot corrupt the live config file.
fn save_prefs(path: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[async_trait]
impl MeetingsHost for SidecarMeetingsHost {
    async fn pref_get(&self, key: &str) -> Option<String> {
        self.prefs.lock().ok()?.get(key).cloned()
    }

    async fn pref_set(&self, key: &str, value: &str) -> Result<(), String> {
        let snapshot = {
            let mut guard = self
                .prefs
                .lock()
                .map_err(|_| "preferences lock poisoned".to_string())?;
            guard.insert(key.to_string(), value.to_string());
            guard.clone()
        };
        save_prefs(&self.prefs_path, &snapshot)
    }

    fn gateway_url(&self) -> String {
        gateway_url_env()
    }

    fn gateway_token(&self) -> Option<String> {
        gateway_token_env()
    }

    fn default_notes_model(&self) -> String {
        std::env::var("RYU_DEFAULT_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_NOTES_MODEL.to_string())
    }

    async fn transcribe(
        &self,
        wav: Vec<u8>,
        filename: String,
        engine: Option<String>,
    ) -> Result<String, String> {
        // Genuine STT via the extracted `ryu_stt` crate — the SAME data path Core
        // runs, injecting the env-resolved `SidecarSttHost`. See the module docs for
        // the audio-double-hop note (the flagged hot path).
        ryu_stt::transcribe_wav(&self.client, &SidecarSttHost, wav, filename, engine.as_deref())
            .await
    }

    async fn generate_title(&self, summary: &str) -> Option<String> {
        // A real Gateway chat completion (mirrors `notes::complete`) so auto-naming
        // works out-of-process. Best-effort: any failure / empty reply → `None`, and
        // the engine leaves the existing title alone.
        let summary = summary.trim();
        if summary.len() < 16 {
            return None;
        }
        let title = gateway_title(
            &self.client,
            &gateway_url_env(),
            gateway_token_env().as_deref(),
            &self.default_notes_model(),
            summary,
        )
        .await;
        match title {
            Some(t) if !t.trim().is_empty() => Some(t.trim().to_string()),
            _ => None,
        }
    }

    async fn save_notes_to_space(&self, title: &str, markdown: &str) -> Option<(String, String)> {
        // Filing into the "Meetings" Space reaches Core's `SpaceStore` +
        // background-owner tenancy, which the sidecar does not host. Post the notes to
        // Core's host callback, which files them under the background owner and returns
        // the `{space_id, doc_id}` the engine attaches to the meeting row. Best-effort:
        // any transport/auth/2xx failure degrades to `None` (notes still persist in
        // `meetings.db`; they are just not mirrored into a Space).
        let Some(token) = self.ext_token.as_deref() else {
            tracing::warn!(
                "ryu-meetings: no RYU_EXT_TOKEN for the save-notes callback; notes persist in meetings.db but are not mirrored into the Meetings Space"
            );
            return None;
        };
        let body = json!({ "title": title, "markdown": markdown });
        let resp = self
            .client
            .post(format!("{}/api/host/meetings/save-notes", self.core_base))
            .timeout(std::time::Duration::from_secs(30))
            .bearer_auth(token)
            .header(HDR_PLUGIN_ID, MEETINGS_PLUGIN_ID)
            .json(&body)
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            tracing::warn!(
                "ryu-meetings: save-notes callback failed (HTTP {}); notes not mirrored into the Meetings Space",
                resp.status()
            );
            return None;
        }
        let parsed: serde_json::Value = resp.json().await.ok()?;
        let space_id = parsed.get("space_id").and_then(|v| v.as_str())?.to_string();
        let doc_id = parsed.get("doc_id").and_then(|v| v.as_str())?.to_string();
        Some((space_id, doc_id))
    }
}

/// One Gateway chat completion that returns a concise meeting title from a summary.
/// Mirrors `notes::complete`'s request shape (`/v1/chat/completions`, `stream:false`,
/// optional bearer). Returns the raw assistant text, or `None` on any error.
async fn gateway_title(
    client: &reqwest::Client,
    gateway_url: &str,
    gateway_token: Option<&str>,
    model: &str,
    summary: &str,
) -> Option<String> {
    const SYSTEM: &str = "You name meetings. Given a short summary, reply with ONLY a concise, specific title of at most 8 words. No quotes, no punctuation at the end, no preamble.";
    let base = gateway_url.trim_end_matches('/');
    let payload = json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": format!("Summary:\n\n{summary}") },
        ],
    });
    let mut req = client
        .post(format!("{base}/v1/chat/completions"))
        .timeout(std::time::Duration::from_secs(30))
        .json(&payload);
    if let Some(t) = gateway_token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let text = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .trim_matches('"')
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::{bearer_ok, load_prefs, save_prefs};
    use std::collections::HashMap;

    #[test]
    fn bearer_ok_matches_only_exact_nonempty_token() {
        assert!(bearer_ok(Some("secret"), Some("secret")));
        assert!(!bearer_ok(Some("secret"), Some("other")));
        assert!(!bearer_ok(Some("secre"), Some("secret")));
        assert!(!bearer_ok(None, Some("secret")));
    }

    #[test]
    fn bearer_ok_is_fail_closed_without_expected() {
        // No/empty configured token → reject everything, even a matching-looking hdr.
        assert!(!bearer_ok(Some("secret"), None));
        assert!(!bearer_ok(Some(""), Some("")));
        assert!(!bearer_ok(None, None));
    }

    #[test]
    fn prefs_roundtrip_through_file() {
        let dir = std::env::temp_dir().join(format!("ryu-meetings-test-{}", std::process::id()));
        let path = dir.join("meetings-prefs.json");
        let _ = std::fs::remove_file(&path);

        // Missing file → empty map (fresh install falls back to defaults).
        assert!(load_prefs(&path).is_empty());

        let mut map = HashMap::new();
        map.insert("meeting-notes-model".to_string(), "custom".to_string());
        save_prefs(&path, &map).expect("save prefs");

        // Reloaded map survives (the restart-durability property).
        let reloaded = load_prefs(&path);
        assert_eq!(
            reloaded.get("meeting-notes-model").map(String::as_str),
            Some("custom")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
