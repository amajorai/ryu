//! Core-side typed HTTP client + host callback for the out-of-process
//! `ryu-meetings` sidecar.
//!
//! Meeting notes (record → live transcript → AI notes) used to run in-process: a
//! `ryu_meetings::MeetingEngine` field on `ServerState`, an `/api/meetings/*` route
//! merge, an openapi sub-doc merge, an activity subscribe-loop over the in-process
//! `MeetingEvent` broadcast, a unified-SSE `meetings` channel, and the hardware
//! ambient-audio bridge feeding the engine directly. Meetings is now an
//! out-of-process app (`com.ryu.meetings`): the `ryu-meetings` sidecar owns
//! `meetings.db`, the engine + audio/diarize pipeline, and the `/api/meetings/*`
//! surface — served to the desktop through the generic ext-proxy `public_mount`.
//! Core links NO meeting code; its reverse couplings reach the sidecar over loopback
//! via this client, and the sidecar reaches BACK into Core through one
//! ext-bearer-authed host callback:
//!
//! - **hardware ambient ingest** — the kernel `ryu-hardware` crate's ambient-audio
//!   path reaches meetings through the [`ryu_hardware::MeetingIngest`] seam; this
//!   client is its out-of-process impl (resume-check `GET /api/meetings/:id`, open
//!   `POST /api/meetings`, append `POST /api/meetings/:id/chunk`). The append hop is
//!   segment-rate (~1 POST/s/device carrying a ~1 s WAV), never per-frame.
//! - **activity feed** — Core folds the sidecar's `/api/meetings/stream` SSE into the
//!   activity store (the old in-process subscribe-loop, now dep-free JSON).
//! - **data-admin clear** — the bulk "clear all meetings" path lists + deletes rows
//!   over the loopback client.
//! - **notes → Space (`save-notes` host callback)** — filing finalized notes into the
//!   "Meetings" Space reaches Core's `SpaceStore` + background-owner tenancy, which
//!   the sidecar does not host. [`host_save_notes`] runs that filing on the sidecar's
//!   behalf under the background owner and returns `(space_id, doc_id)`.
//!
//! Security mirrors the ext-proxy hop exactly: the loopback client presents the
//! per-plugin minted bearer ([`crate::sidecar::ext_proxy::ext_token`]); the host
//! callback authenticates the sidecar with the SAME token via
//! [`crate::sidecar::ext_proxy::authenticate_sidecar`] — nothing hardcoded.

use std::time::Duration;

use async_trait::async_trait;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::StreamExt;
use ryu_activity::{ActivityItem, ActivityLevel, ActivityStore};
use ryu_hardware::MeetingIngest;
use serde_json::{json, Value};

use crate::plugins::builtins::MEETINGS_PLUGIN_ID;
use crate::server::spaces::{self, SpaceStore};
use crate::server::ServerState;
use crate::sidecar::ext_proxy::{authenticate_sidecar, ext_token, node_token};

/// Fallback loopback port if the manifest is somehow absent — matches the
/// `meetings.plugin.json` fixture `port`. Core injects this as `RYU_MEETINGS_PORT`
/// at spawn.
const MEETINGS_FALLBACK_PORT: u16 = 7998;

/// The ambient app label recorded on a hardware-opened meeting (matches the old
/// in-process `open_or_resume_ambient` call).
const AMBIENT_APP: &str = "ryu-hardware";

/// The Space that auto-saved meeting notes land in. Reusing the Spaces feature gives
/// editing (the PlateJS markdown editor) + RAG search for free. Lifted verbatim from
/// the old in-process `meetings_host`.
const MEETINGS_SPACE_NAME: &str = "Meetings";

/// Resolve the `ryu-meetings` sidecar's loopback port from the loaded manifests,
/// profile-shifted the same way the ext-proxy forwards ([`crate::profile::port`]).
pub fn sidecar_port(manifests: &[crate::plugin_manifest::PluginManifest]) -> u16 {
    let raw = manifests
        .iter()
        .find(|m| m.id == MEETINGS_PLUGIN_ID)
        .and_then(|m| m.sidecars.iter().find(|s| s.name == "ryu-meetings"))
        .map(|s| s.port)
        .unwrap_or(MEETINGS_FALLBACK_PORT);
    crate::profile::port(raw)
}

/// Typed loopback client for the `ryu-meetings` sidecar. Cheap to clone (holds only
/// the resolved port); the bearer is minted per call so it always tracks the current
/// node token.
#[derive(Clone)]
pub struct MeetingsClient {
    port: u16,
}

impl MeetingsClient {
    /// Build a client bound to the sidecar's resolved loopback port.
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/api/meetings", self.port)
    }

    /// The per-plugin minted bearer the sidecar was spawned with — the same value the
    /// ext-proxy stamps on its hop, so a hand-rolled local request without it is
    /// rejected fail-closed.
    fn bearer(&self) -> String {
        ext_token(node_token().as_deref(), MEETINGS_PLUGIN_ID)
    }

    /// Fetch the current meeting list (`GET /api/meetings`), returning the `meetings`
    /// array. An unreachable sidecar or error body yields an empty list.
    pub async fn list(&self) -> Result<Vec<Value>, String> {
        let resp = reqwest::Client::new()
            .get(self.base_url())
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| format!("meetings sidecar not reachable: {e}"))?;
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        Ok(body
            .get("meetings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// Delete a meeting (`DELETE /api/meetings/:id`). Returns `Ok(true)` when a row was
    /// removed.
    pub async fn delete(&self, meeting_id: &str) -> Result<bool, String> {
        let resp = reqwest::Client::new()
            .delete(format!("{}/{meeting_id}", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| format!("meetings sidecar not reachable: {e}"))?;
        Ok(resp.status().is_success())
    }
}

/// The `MeetingsClient` IS the out-of-process [`MeetingIngest`] impl the hardware
/// ambient path drives (replacing the in-process `meetings_ingest::in_proc`). Every
/// call is one loopback hop to the sidecar.
#[async_trait]
impl MeetingIngest for MeetingsClient {
    async fn meeting_exists(&self, meeting_id: &str) -> bool {
        let Ok(resp) = reqwest::Client::new()
            .get(format!("{}/{meeting_id}", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
        else {
            return false;
        };
        resp.status().is_success()
    }

    async fn start_meeting(&self, title: String) -> Result<String, String> {
        let resp = reqwest::Client::new()
            .post(self.base_url())
            .bearer_auth(self.bearer())
            .json(&json!({ "title": title, "app": AMBIENT_APP, "source": "auto" }))
            .send()
            .await
            .map_err(|e| format!("meetings sidecar not reachable: {e}"))?;
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        body.get("meeting")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                body.get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| "meetings start: no meeting id in reply".to_string())
            })
    }

    async fn append_segment(
        &self,
        meeting_id: &str,
        wav: Vec<u8>,
        filename: String,
    ) -> Result<String, String> {
        // Multipart `file` part — byte-identical shape to Shadow's chunk upload, so
        // the sidecar's `ingest_chunk` handler transcribes it the same way.
        let part = reqwest::multipart::Part::bytes(wav).file_name(filename);
        let form = reqwest::multipart::Form::new().part("file", part);
        let resp = reqwest::Client::new()
            .post(format!("{}/{meeting_id}/chunk", self.base_url()))
            .bearer_auth(self.bearer())
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("meetings sidecar not reachable: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        // The sidecar returns 200 `{segment:null, skipped:"...silence..."}` for a
        // silent chunk; surface that as an `Err` whose message keeps the "silence"
        // marker the caller (`flush_ambient`) maps to an `ambient_skip`.
        if let Some(skipped) = body.get("skipped").and_then(Value::as_str) {
            return Err(skipped.to_string());
        }
        if !status.is_success() {
            return Err(body
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("meetings chunk failed: HTTP {status}")));
        }
        body.get("segment")
            .and_then(|s| s.get("id"))
            .map(|id| id.to_string())
            .ok_or_else(|| "meetings chunk: no segment id in reply".to_string())
    }
}

// ── Activity feed fold (sidecar SSE → activity store) ──────────────────────────────

/// Parse an RFC3339 timestamp into epoch seconds, falling back to "now" so a malformed
/// source timestamp never drops an item. Mirrors `activity::ingest::epoch_secs`.
fn epoch_secs(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|d| d.timestamp())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp())
}

/// Map a meeting SSE event (JSON, `#[serde(tag = "type")]`) into an activity item —
/// the dep-free rewrite of the old `activity::ingest::from_meeting_event`. Only
/// lifecycle boundaries make the feed; per-segment/status churn is dropped (`None`).
fn activity_from_meeting_json(event: &Value) -> Option<ActivityItem> {
    let kind = event.get("type").and_then(Value::as_str)?;
    let item = match kind {
        "detected" => {
            let title = event.get("title").and_then(Value::as_str).unwrap_or("");
            let app = event.get("app").and_then(Value::as_str).unwrap_or("");
            let detected_at = event
                .get("detected_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            ActivityItem::new("meeting", "meetings", format!("Meeting detected: {title}"))
                .with_metadata(json!({ "app": app }))
                .with_created_at(epoch_secs(detected_at))
        }
        "started" => {
            let meeting = event.get("meeting")?;
            let title = meeting.get("title").and_then(Value::as_str).unwrap_or("");
            let id = meeting.get("id").and_then(Value::as_str).unwrap_or("");
            let started_at = meeting
                .get("started_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            ActivityItem::new("meeting", "meetings", format!("Meeting started: {title}"))
                .with_metadata(json!({ "meeting_id": id }))
                .with_created_at(epoch_secs(started_at))
        }
        "finalized" => {
            let meeting = event.get("meeting")?;
            let title = meeting.get("title").and_then(Value::as_str).unwrap_or("");
            let id = meeting.get("id").and_then(Value::as_str).unwrap_or("");
            let space_id = meeting.get("space_id").cloned().unwrap_or(Value::Null);
            let updated_at = meeting
                .get("updated_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            ActivityItem::new(
                "meeting",
                "meetings",
                format!("Meeting notes ready: {title}"),
            )
            .with_level(ActivityLevel::Success)
            .with_metadata(json!({ "meeting_id": id, "space_id": space_id }))
            .with_created_at(epoch_secs(updated_at))
        }
        // `segment` / `status` churn does not make the feed.
        _ => return None,
    };
    Some(item)
}

/// One connection of the meeting-events SSE stream, folding `data:` frames into the
/// activity store until the stream closes or errors (then [`spawn`] reconnects).
async fn stream_activity(client: &MeetingsClient, activity: &ActivityStore) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .get(format!("{}/stream", client.base_url()))
        .bearer_auth(client.bearer())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.trim();
            if payload.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            if let Some(item) = activity_from_meeting_json(&event) {
                if let Err(e) = activity.record(item).await {
                    tracing::warn!("activity: failed to record meeting event: {e:#}");
                }
            }
        }
    }
    Ok(())
}

/// Spawn the Core-side reverse-coupling task for meetings: fold the sidecar's
/// `/api/meetings/stream` SSE into the activity feed. Best-effort and self-healing
/// across a sidecar restart (reconnects after a short backoff). Unlike monitors/quests
/// there is no scheduler-job reconcile — meetings has no backing scheduled job.
pub fn spawn(client: MeetingsClient, activity: ActivityStore) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = stream_activity(&client, &activity).await {
                tracing::debug!("meetings activity stream ended ({e}); retrying");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

// ── Host callback (sidecar → Core) ─────────────────────────────────────────────────

/// The `{ title, markdown }` body the sidecar posts to file finalized notes.
#[derive(serde::Deserialize)]
pub(crate) struct SaveNotesBody {
    title: String,
    markdown: String,
}

/// `POST /api/host/meetings/save-notes` — file a finalized meeting's notes markdown
/// into the "Meetings" Space on the sidecar's behalf, under the background owner. The
/// sidecar cannot host Core's `SpaceStore` + tenancy, so this runs the Spaces filing
/// Core-side and returns `{ space_id, doc_id }` for the sidecar to persist onto the
/// meeting row. Registered on the PUBLIC router, ext-bearer authed.
pub(crate) async fn host_save_notes(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<SaveNotesBody>,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _grants)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    if plugin_id != MEETINGS_PLUGIN_ID {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not the meetings app" })),
        )
            .into_response();
    }

    match save_notes_to_space(&state.spaces, &body.title, &body.markdown).await {
        Some((space_id, doc_id)) => {
            Json(json!({ "space_id": space_id, "doc_id": doc_id })).into_response()
        }
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "filing notes into the Meetings space failed" })),
        )
            .into_response(),
    }
}

/// Find the "Meetings" Space (creating it on first use) and ingest the notes markdown
/// under the background owner. Returns `(space_id, doc_id)` on success. Lifted verbatim
/// from the old in-process `meetings_host::CoreMeetingsHost`, so a decoupled node files
/// notes byte-identically.
async fn save_notes_to_space(
    spaces: &SpaceStore,
    title: &str,
    markdown: &str,
) -> Option<(String, String)> {
    let space_id = ensure_meetings_space(spaces).await?;
    match spaces
        .ingest_document(&space_id, title, markdown, &spaces::background_owner())
        .await
    {
        Ok(doc_id) => Some((space_id, doc_id)),
        Err(e) => {
            tracing::warn!("meetings: saving notes to space failed: {e:#}");
            None
        }
    }
}

/// Find the "Meetings" Space, creating it on first use. Returns its id, or `None` if
/// the spaces store is unavailable.
async fn ensure_meetings_space(spaces: &SpaceStore) -> Option<String> {
    // Get-or-create the "Meetings" space as a SYSTEM space (system=1) so it is
    // undeletable, matching Artifacts/Canvas/Whiteboard/Clips. `ensure_system_space`
    // also re-asserts system=1 on an already-existing row, so a Meetings space
    // created before this change (system=0, individually deletable) is upgraded in
    // place on the next note-save. It replaces the previous list-then-create_space
    // path, which produced a background-owned, deletable space.
    match spaces
        .ensure_system_space(MEETINGS_SPACE_NAME, Some("Auto-saved meeting notes"))
        .await
    {
        Ok(id) => Some(id),
        Err(e) => {
            tracing::warn!("meetings: ensuring Meetings space failed: {e:#}");
            None
        }
    }
}
