//! The hardware ambient-audio path's meeting seam, served by capabilities.
//!
//! The kernel `ryu-hardware` crate reaches meeting notes only through its
//! [`MeetingIngest`] trait. [`CapabilityMeetingIngest`] implements it over the
//! generic [`CapabilityConsumer`], so Core names no meetings app, port, sidecar or
//! route; whichever enabled app provides these serves the ambient session:
//!
//! | Capability | Body → reply |
//! |---|---|
//! | `meetings.get` | `{ id }` → `{ meeting }` (404 when gone) |
//! | `meetings.start` | `{ title, app, source }` → `{ meeting: { id } }` |
//! | `meetings.appendAudio` | `{ id, filename, audio_base64 }` → `{ segment }` / `{ skipped }` |
//!
//! The append fires at segment rate (~1 call/s/device carrying a ~32 KB WAV), never
//! per frame. JSON carries the WAV base64-encoded because a capability call is
//! always a JSON POST.
//!
//! Disabled-app behaviour: with no provider, `meeting_exists` is `false` and
//! `start_meeting` / `append_segment` return the refusal as their error, which the
//! hardware path already logs and survives (the device keeps working without an
//! ambient transcript, and picks a provider up on its next connection).

use async_trait::async_trait;
use base64::Engine as _;
use ryu_hardware::MeetingIngest;
use serde_json::{json, Value};

use crate::sidecar::capability_consumer::CapabilityConsumer;

/// Resolve one meeting by id.
pub(crate) const CAP_MEETINGS_GET: &str = "meetings.get";
/// Open a meeting.
pub(crate) const CAP_MEETINGS_START: &str = "meetings.start";
/// Append one captured audio segment to a meeting's live transcript.
pub(crate) const CAP_MEETINGS_APPEND_AUDIO: &str = "meetings.appendAudio";

/// The app label recorded on a hardware-opened meeting.
const AMBIENT_APP: &str = "ryu-hardware";

/// [`MeetingIngest`] over the `meetings.*` capabilities.
#[derive(Clone)]
pub(crate) struct CapabilityMeetingIngest {
    capabilities: CapabilityConsumer,
}

impl CapabilityMeetingIngest {
    pub(crate) fn new(capabilities: CapabilityConsumer) -> Self {
        Self { capabilities }
    }
}

/// The provider's `error` text, else a status line.
fn reply_error(cap: &str, status: u16, body: &Value) -> String {
    body.get("error")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{cap} failed: HTTP {status}"))
}

#[async_trait]
impl MeetingIngest for CapabilityMeetingIngest {
    async fn meeting_exists(&self, meeting_id: &str) -> bool {
        self.capabilities
            .call_capability(CAP_MEETINGS_GET, &json!({ "id": meeting_id }))
            .await
            .is_ok_and(|reply| reply.is_success())
    }

    async fn start_meeting(&self, title: String) -> Result<String, String> {
        let reply = self
            .capabilities
            .call_capability(
                CAP_MEETINGS_START,
                &json!({ "title": title, "app": AMBIENT_APP, "source": "auto" }),
            )
            .await
            .map_err(|e| e.to_string())?;
        if !reply.is_success() {
            return Err(reply_error(CAP_MEETINGS_START, reply.status, &reply.body));
        }
        reply
            .body
            .get("meeting")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "meetings.start: no meeting id in reply".to_owned())
    }

    async fn append_segment(
        &self,
        meeting_id: &str,
        wav: Vec<u8>,
        filename: String,
    ) -> Result<String, String> {
        let body = json!({
            "id": meeting_id,
            "filename": filename,
            "audio_base64": base64::engine::general_purpose::STANDARD.encode(wav),
        });
        let reply = self
            .capabilities
            .call_capability(CAP_MEETINGS_APPEND_AUDIO, &body)
            .await
            .map_err(|e| e.to_string())?;
        // A silent chunk is a 200 `{ segment: null, skipped: "...silence..." }`;
        // surface it as an `Err` that keeps the marker the caller maps to an
        // `ambient_skip`.
        if let Some(skipped) = reply.body.get("skipped").and_then(Value::as_str) {
            return Err(skipped.to_owned());
        }
        if !reply.is_success() {
            return Err(reply_error(
                CAP_MEETINGS_APPEND_AUDIO,
                reply.status,
                &reply.body,
            ));
        }
        reply
            .body
            .get("segment")
            .and_then(|s| s.get("id"))
            .map(Value::to_string)
            .ok_or_else(|| "meetings.appendAudio: no segment id in reply".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::capability_consumer::test_support::{
        consumer_with, consumer_without_providers, fixture_manifest, registered, serve,
    };
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::{Json, Router};

    const PROVIDES: &[(&str, Option<&str>)] = &[
        (CAP_MEETINGS_GET, Some("/resolve")),
        (CAP_MEETINGS_START, Some("/start")),
        (CAP_MEETINGS_APPEND_AUDIO, Some("/ambient/chunk")),
    ];

    /// A fake provider: one known meeting, ambient starts mint `m-new`, and an
    /// all-zero WAV is "silence".
    fn fake_meetings() -> Router {
        Router::new()
            .route(
                "/api/fixture/resolve",
                post(|Json(body): Json<Value>| async move {
                    if body["id"] == "m-known" {
                        (
                            StatusCode::OK,
                            Json(json!({ "meeting": { "id": "m-known" } })),
                        )
                    } else {
                        (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })))
                    }
                }),
            )
            .route(
                "/api/fixture/start",
                post(|Json(body): Json<Value>| async move {
                    assert_eq!(body["app"], AMBIENT_APP);
                    assert_eq!(body["source"], "auto");
                    Json(json!({ "meeting": { "id": "m-new", "title": body["title"] } }))
                }),
            )
            .route(
                "/api/fixture/ambient/chunk",
                post(|Json(body): Json<Value>| async move {
                    let wav = base64::engine::general_purpose::STANDARD
                        .decode(body["audio_base64"].as_str().unwrap_or_default())
                        .unwrap_or_default();
                    if wav.iter().all(|b| *b == 0) {
                        return Json(json!({ "segment": null, "skipped": "chunk is silence" }));
                    }
                    assert_eq!(body["id"], "m-new");
                    assert_eq!(body["filename"], "seg.wav");
                    Json(json!({ "segment": { "id": 42 } }))
                }),
            )
    }

    #[tokio::test]
    async fn ambient_ingest_speaks_the_meetings_capabilities() {
        let (consumer, _sidecar, port) = registered(PROVIDES).await;
        let server = serve(port, fake_meetings()).await;
        let ingest = CapabilityMeetingIngest::new(consumer);

        assert!(ingest.meeting_exists("m-known").await);
        assert!(!ingest.meeting_exists("m-deleted").await);
        assert_eq!(
            ingest.start_meeting("Ambient — desk".into()).await,
            Ok("m-new".to_owned())
        );
        assert_eq!(
            ingest
                .append_segment("m-new", vec![1, 2, 3], "seg.wav".into())
                .await,
            Ok("42".to_owned())
        );
        let skipped = ingest
            .append_segment("m-new", vec![0, 0], "seg.wav".into())
            .await
            .unwrap_err();
        assert!(skipped.contains("silence"), "{skipped}");
        server.abort();
    }

    /// With the Meetings app disabled or absent, the ambient path degrades: no
    /// meeting resumes, opening one is a clean error the hardware session logs.
    #[tokio::test]
    async fn ambient_ingest_fails_open_without_a_provider() {
        let disabled = consumer_with(fixture_manifest(1, PROVIDES), false).await;
        for consumer in [disabled, consumer_without_providers()] {
            let ingest = CapabilityMeetingIngest::new(consumer);
            assert!(!ingest.meeting_exists("m-known").await);
            let err = ingest.start_meeting("t".into()).await.unwrap_err();
            assert!(err.contains(CAP_MEETINGS_START), "{err}");
            let err = ingest
                .append_segment("m", vec![1], "seg.wav".into())
                .await
                .unwrap_err();
            assert!(err.contains(CAP_MEETINGS_APPEND_AUDIO), "{err}");
        }
    }
}
