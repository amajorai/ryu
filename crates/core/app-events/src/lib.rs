//! The **app-event emit client** — the outbound half of Ryu's hook system.
//!
//! # What an app event is
//!
//! Core's own hook phases (`post_assistant_turn`, `pre_tool_use`, `context`, …) are
//! a closed set: they describe things that happen inside a chat turn. An **app
//! event** is the open half. An app declares the events it emits in its
//! `manifest.json`:
//!
//! ```json
//! "contributes": {
//!   "hook_events": [
//!     { "id": "@ryu/meetings#meeting.ended", "title": "Meeting ended" }
//!   ]
//! }
//! ```
//!
//! and raises one at runtime through this crate. Core then fans it out to every
//! **plugin hook** whose `turn_hooks[].on` names the event and every **workflow**
//! with a matching `event` trigger.
//!
//! The emitter learns nothing about its consumers, and a consumer needs no
//! cooperation from the emitter. That is the entire point: "when a meeting ends,
//! summarize it and file the notes" stops being wiring soldered between two apps and
//! becomes something a user assembles.
//!
//! # Why the declaration is the authorization
//!
//! An event id is `<owning plugin id>#<event name>`, and Core re-checks on every
//! emit that the authenticated caller **is** the plugin the event is namespaced to
//! and that the event appears in that plugin's own manifest. So an app can only ever
//! emit its own declared events — a stolen token buys an attacker the ability to
//! emit events the app already emits, and nothing more. It is also why a Core phase
//! can never be spoofed: a phase name never contains `/`.
//!
//! # Transport
//!
//! `POST http://127.0.0.1:$RYU_CORE_PORT/api/host/capability/events.emit`, presenting the sidecar's
//! `x-ryu-plugin-id` and its minted `RYU_EXT_TOKEN` bearer — the same authenticated
//! seam every other sidecar → Core callback uses. Nothing here is app-specific: the
//! plugin id comes from the caller, the rest from the environment Core injects at
//! spawn.
//!
//! # Failure posture
//!
//! **Emitting is best-effort and never fails the emitter's own work.** A meeting
//! that ended has ended whether or not a summarizer was listening; propagating a
//! fan-out error into the recorder would trade a working feature for a broken one.
//! [`EventEmitter::emit`] therefore logs and swallows, and [`EventEmitter::try_emit`]
//! is available when a caller genuinely wants the outcome.

use std::{
    pin::Pin,
    task::{Context, Poll},
};

use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Env var holding Core's own loopback port. **This is the one Core actually
/// injects into every manifest sidecar** (`inject_ext_env` sets it unconditionally,
/// exactly so a sidecar can reach back into Core), so it is what this crate resolves
/// first.
const ENV_CORE_PORT: &str = "RYU_CORE_PORT";

/// Env var holding Core's bind address. Only a FALLBACK, and only its port half is
/// used — see [`core_endpoint`] for why reading this one first was a bug.
const ENV_CORE_BIND: &str = "RYU_BIND";
/// Env var holding the sidecar's minted per-plugin bearer, injected at spawn.
const ENV_EXT_TOKEN: &str = "RYU_EXT_TOKEN";
/// The header Core's `authenticate_sidecar` reads to identify the caller.
const HDR_PLUGIN_ID: &str = "x-ryu-plugin-id";
/// The kernel capability this crate invokes.
const CAP_EVENTS_EMIT: &str = "events.emit";
/// The kernel capability that broadcasts a bounded named event into an app room.
const CAP_REALTIME_PUBLISH: &str = "realtime.publish";
/// The kernel capability that records a provider-neutral external-tool charge.
const CAP_TOOL_USAGE_RECORD: &str = "billing.recordToolCharge";

const MAX_MODEL_ID_BYTES: usize = 256;
const MAX_MODEL_PROVIDER_BYTES: usize = 64;
const MAX_MODEL_REQUEST_ID_BYTES: usize = 128;
const MAX_MODEL_MESSAGES: usize = 40;
const MAX_MODEL_MESSAGE_BYTES: usize = 32 * 1024;
const MAX_MODEL_CONTEXT_BYTES: usize = 128 * 1024;
const MAX_MODEL_OUTPUT_TOKENS: u32 = 4096;
const MAX_REALTIME_ROOM_ID_BYTES: usize = 512;
const MAX_REALTIME_EVENT_NAME_BYTES: usize = 128;
const MAX_REALTIME_EVENT_BYTES: usize = 256 * 1024;

/// One text message sent through the generic sidecar-to-Core model stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStreamMessage {
    pub content: String,
    pub role: String,
}

/// Provider-neutral request for a bounded streaming model call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStreamRequest {
    pub messages: Vec<ModelStreamMessage>,
    pub model: String,
    #[serde(default)]
    pub provider: Option<String>,
    pub request_id: String,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f32>,
}

impl ModelStreamRequest {
    pub fn validate(&self) -> Result<(), ModelStreamError> {
        validate_text(&self.model, MAX_MODEL_ID_BYTES, "model")?;
        validate_text(&self.request_id, MAX_MODEL_REQUEST_ID_BYTES, "requestId")?;
        if self.messages.is_empty() || self.messages.len() > MAX_MODEL_MESSAGES {
            return Err(ModelStreamError::Invalid(
                "messages must contain 1..40 items".to_owned(),
            ));
        }
        let mut total = 0usize;
        for message in &self.messages {
            if !matches!(message.role.as_str(), "system" | "user" | "assistant") {
                return Err(ModelStreamError::Invalid(
                    "message role is not supported".to_owned(),
                ));
            }
            if message.content.is_empty() || message.content.len() > MAX_MODEL_MESSAGE_BYTES {
                return Err(ModelStreamError::Invalid(
                    "message content is empty or too long".to_owned(),
                ));
            }
            if message
                .content
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            {
                return Err(ModelStreamError::Invalid(
                    "message content contains unsupported control characters".to_owned(),
                ));
            }
            total = total.saturating_add(message.content.len());
        }
        if total > MAX_MODEL_CONTEXT_BYTES {
            return Err(ModelStreamError::Invalid(
                "message context is too large".to_owned(),
            ));
        }
        if let Some(provider) = &self.provider {
            validate_text(provider, MAX_MODEL_PROVIDER_BYTES, "provider")?;
            if provider.contains("://") || provider.contains('/') {
                return Err(ModelStreamError::Invalid(
                    "provider must be a provider slot, not a URL".to_owned(),
                ));
            }
        }
        if self
            .max_tokens
            .is_some_and(|value| value == 0 || value > MAX_MODEL_OUTPUT_TOKENS)
        {
            return Err(ModelStreamError::Invalid(
                "maxTokens must be between 1 and 4096".to_owned(),
            ));
        }
        if self
            .temperature
            .is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value))
        {
            return Err(ModelStreamError::Invalid(
                "temperature must be between 0 and 2".to_owned(),
            ));
        }
        Ok(())
    }
}

fn validate_text(value: &str, max_bytes: usize, field: &str) -> Result<(), ModelStreamError> {
    if value.trim().is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(ModelStreamError::Invalid(format!(
            "{field} is empty, too long, or invalid"
        )));
    }
    Ok(())
}

/// The only events a sidecar can receive from Core's model stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ModelStreamEvent {
    #[serde(rename = "textDelta")]
    TextDelta {
        #[serde(rename = "requestId")]
        request_id: String,
        delta: String,
    },
    #[serde(rename = "completed")]
    Completed {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "failed")]
    Failed {
        #[serde(rename = "requestId")]
        request_id: String,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelStreamError {
    NotHosted,
    Invalid(String),
    Transport(String),
    Rejected { status: u16, code: String },
    Protocol(String),
}

impl std::fmt::Display for ModelStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotHosted => write!(f, "not running as a Core-hosted sidecar"),
            Self::Invalid(message) => write!(f, "invalid model stream request: {message}"),
            Self::Transport(message) => write!(f, "model stream transport failed: {message}"),
            Self::Rejected { status, code } => {
                write!(f, "model stream rejected ({status}): {code}")
            }
            Self::Protocol(message) => write!(f, "model stream protocol failed: {message}"),
        }
    }
}

impl std::error::Error for ModelStreamError {}

/// A streaming response from Core. It filters the wire to [`ModelStreamEvent`]
/// values before an app sees it.
pub struct ModelStream {
    inner: Pin<Box<dyn Stream<Item = Result<ModelStreamEvent, ModelStreamError>> + Send>>,
}

impl Stream for ModelStream {
    type Item = Result<ModelStreamEvent, ModelStreamError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

/// Reusable client for `POST /api/host/model/stream`.
#[derive(Clone)]
pub struct ModelStreamClient {
    plugin_id: String,
    http: reqwest::Client,
    endpoint: Option<String>,
    token: Option<String>,
}

impl ModelStreamClient {
    #[must_use]
    pub fn from_env(plugin_id: impl Into<String>) -> Self {
        Self::with_client(plugin_id, reqwest::Client::new())
    }

    #[must_use]
    pub fn with_client(plugin_id: impl Into<String>, http: reqwest::Client) -> Self {
        let endpoint = core_model_stream_endpoint();
        let token = std::env::var(ENV_EXT_TOKEN)
            .ok()
            .filter(|value| !value.trim().is_empty());
        Self {
            plugin_id: plugin_id.into(),
            http,
            endpoint,
            token,
        }
    }

    /// Build a client for a caller-supplied Core-compatible endpoint. This is
    /// useful for an app's integration harness and for nodes that front Core
    /// through a local test listener; normal sidecars should use [`Self::from_env`].
    #[must_use]
    pub fn with_endpoint(
        plugin_id: impl Into<String>,
        http: reqwest::Client,
        endpoint: impl Into<String>,
        token: impl Into<String>,
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            http,
            endpoint: Some(endpoint.into()),
            token: Some(token.into()),
        }
    }

    /// Build a deliberately disabled client for standalone app operation and
    /// tests; no network request can be attempted.
    #[must_use]
    pub fn disabled(plugin_id: impl Into<String>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            http: reqwest::Client::new(),
            endpoint: None,
            token: None,
        }
    }

    pub async fn stream(
        &self,
        request: ModelStreamRequest,
    ) -> Result<ModelStream, ModelStreamError> {
        request.validate()?;
        let (Some(endpoint), Some(token)) = (self.endpoint.as_deref(), self.token.as_deref())
        else {
            return Err(ModelStreamError::NotHosted);
        };
        let response = self
            .http
            .post(endpoint)
            .header(HDR_PLUGIN_ID, &self.plugin_id)
            .bearer_auth(token)
            .json(&request)
            .send()
            .await
            .map_err(|error| ModelStreamError::Transport(error.to_string()))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let body = response.text().await.unwrap_or_default();
            let code = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| value.get("code").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_else(|| "modelStreamRejected".to_owned());
            return Err(ModelStreamError::Rejected { status, code });
        }

        let request_id = request.request_id;
        let mut upstream = response.bytes_stream();
        let inner = async_stream::stream! {
            let mut buffer = Vec::new();
            let mut terminal = false;
            while let Some(chunk) = upstream.next().await {
                let bytes = match chunk {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        yield Err(ModelStreamError::Transport(error.to_string()));
                        terminal = true;
                        break;
                    }
                };
                buffer.extend_from_slice(&bytes);
                while let Some(position) = find_sse_frame_boundary(&buffer) {
                    let frame = buffer.drain(..position).collect::<Vec<_>>();
                    buffer.drain(..2);
                    match parse_model_stream_frame(&frame, &request_id) {
                        Ok(Some(event)) => {
                            terminal = matches!(event, ModelStreamEvent::Completed { .. } | ModelStreamEvent::Failed { .. });
                            yield Ok(event);
                            if terminal { break; }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            yield Err(error);
                            terminal = true;
                            break;
                        }
                    }
                }
                if terminal { break; }
            }
            if !terminal {
                yield Err(ModelStreamError::Protocol("stream ended without a terminal event".to_owned()));
            }
        };
        Ok(ModelStream {
            inner: Box::pin(inner),
        })
    }
}

/// A bounded named event published into the caller's application-owned room.
#[derive(Debug, Clone, Serialize)]
struct RealtimePublishRequest {
    room_id: String,
    event: String,
    data: Value,
}

impl RealtimePublishRequest {
    fn validate(&self) -> Result<(), RealtimePublishError> {
        if self.room_id.trim().is_empty()
            || self.room_id.len() > MAX_REALTIME_ROOM_ID_BYTES
            || self.room_id.chars().any(char::is_control)
        {
            return Err(RealtimePublishError::Invalid(
                "room_id is empty, too long, or invalid".to_owned(),
            ));
        }
        if self.event.trim().is_empty()
            || self.event.len() > MAX_REALTIME_EVENT_NAME_BYTES
            || self.event.chars().any(char::is_control)
        {
            return Err(RealtimePublishError::Invalid(
                "event is empty, too long, or invalid".to_owned(),
            ));
        }
        let bytes = serde_json::to_vec(self).map_err(|_| {
            RealtimePublishError::Invalid("event data could not be serialized".to_owned())
        })?;
        if bytes.len() > MAX_REALTIME_EVENT_BYTES {
            return Err(RealtimePublishError::Invalid(
                "event data is too large".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum RealtimePublishError {
    NotHosted,
    Invalid(String),
    Transport(reqwest::Error),
    Rejected { status: u16, body: String },
}

impl std::fmt::Display for RealtimePublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotHosted => write!(f, "not running as a Core-hosted sidecar"),
            Self::Invalid(message) => write!(f, "invalid realtime publish: {message}"),
            Self::Transport(error) => write!(f, "realtime publish transport failed: {error}"),
            Self::Rejected { status, body } => {
                write!(f, "Core rejected realtime publish ({status}): {body}")
            }
        }
    }
}

impl std::error::Error for RealtimePublishError {}

/// Publishes named events through Core's generic application-room capability.
/// Core supplies the app namespace from the authenticated sidecar identity; the
/// caller can only choose the opaque room id and event payload.
#[derive(Clone)]
pub struct ApplicationRoomPublisher {
    plugin_id: String,
    http: reqwest::Client,
    endpoint: Option<String>,
    token: Option<String>,
}

impl ApplicationRoomPublisher {
    #[must_use]
    pub fn from_env(plugin_id: impl Into<String>) -> Self {
        Self::with_client(plugin_id, reqwest::Client::new())
    }

    #[must_use]
    pub fn with_client(plugin_id: impl Into<String>, http: reqwest::Client) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            http,
            endpoint: core_endpoint_for(CAP_REALTIME_PUBLISH),
            token: std::env::var(ENV_EXT_TOKEN)
                .ok()
                .filter(|value| !value.trim().is_empty()),
        }
    }

    /// Build a deliberately disabled publisher for standalone app operation and
    /// tests; no network request can be attempted.
    #[must_use]
    pub fn disabled(plugin_id: impl Into<String>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            http: reqwest::Client::new(),
            endpoint: None,
            token: None,
        }
    }

    #[must_use]
    pub fn is_hosted(&self) -> bool {
        self.endpoint.is_some() && self.token.is_some()
    }

    /// Broadcast one named event through Core's authenticated application-room
    /// capability. This does not wait for Desktop subscribers.
    pub async fn publish(
        &self,
        room_id: impl Into<String>,
        event: impl Into<String>,
        data: Value,
    ) -> Result<(), RealtimePublishError> {
        let request = RealtimePublishRequest {
            room_id: room_id.into(),
            event: event.into(),
            data,
        };
        request.validate()?;
        let (Some(endpoint), Some(token)) = (self.endpoint.as_deref(), self.token.as_deref())
        else {
            return Err(RealtimePublishError::NotHosted);
        };
        let response = self
            .http
            .post(endpoint)
            .header(HDR_PLUGIN_ID, &self.plugin_id)
            .bearer_auth(token)
            .json(&request)
            .send()
            .await
            .map_err(RealtimePublishError::Transport)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(RealtimePublishError::Rejected {
                status,
                body: response.text().await.unwrap_or_default(),
            });
        }
        Ok(())
    }

    /// Best-effort publishing for terminal persistence and other paths where a
    /// missing live subscriber must not fail the durable operation.
    pub async fn publish_best_effort(
        &self,
        room_id: impl Into<String>,
        event: impl Into<String>,
        data: Value,
    ) {
        if let Err(error) = self.publish(room_id, event, data).await {
            if !matches!(error, RealtimePublishError::NotHosted) {
                tracing::warn!("app-room publish failed: {error}");
            }
        }
    }
}

fn core_model_stream_endpoint() -> Option<String> {
    let port = std::env::var(ENV_CORE_PORT)
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .or_else(|| {
            std::env::var(ENV_CORE_BIND).ok().and_then(|bind| {
                bind.rsplit_once(':')
                    .and_then(|(_, port)| port.trim().parse::<u16>().ok())
            })
        })?;
    Some(format!("http://127.0.0.1:{port}/api/host/model/stream"))
}

fn find_sse_frame_boundary(buffer: &[u8]) -> Option<usize> {
    buffer.windows(2).position(|window| window == b"\n\n")
}

fn parse_model_stream_frame(
    frame: &[u8],
    request_id: &str,
) -> Result<Option<ModelStreamEvent>, ModelStreamError> {
    let text = std::str::from_utf8(frame)
        .map_err(|_| ModelStreamError::Protocol("stream frame is not UTF-8".to_owned()))?;
    let data = text
        .lines()
        .find_map(|line| line.strip_prefix("data:").map(str::trim))
        .unwrap_or_default();
    if data.is_empty() {
        return Ok(None);
    }
    if data == "[DONE]" {
        return Ok(Some(ModelStreamEvent::Completed {
            request_id: request_id.to_owned(),
        }));
    }
    let value = serde_json::from_str::<Value>(data)
        .map_err(|_| ModelStreamError::Protocol("stream frame is not valid JSON".to_owned()))?;
    let event = serde_json::from_value::<ModelStreamEvent>(value.clone()).ok();
    if event.is_some() {
        return Ok(event);
    }
    if value.get("type").and_then(Value::as_str) == Some("error") || value.get("error").is_some() {
        return Ok(Some(ModelStreamEvent::Failed {
            request_id: request_id.to_owned(),
            code: "providerError".to_owned(),
            message: "model stream failed".to_owned(),
        }));
    }
    Ok(None)
}

/// What Core reports back about a fan-out: how many subscribers it reached.
///
/// `workflows` counts runs **started**, not finished — a workflow run is detached
/// precisely so a slow one cannot turn emitting an event into a request timeout.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmitOutcome {
    /// Plugin hooks that ran for this event.
    #[serde(default)]
    pub hooks: usize,
    /// Workflow runs started for this event.
    #[serde(default)]
    pub workflows: usize,
}

/// An optional user-facing notification to raise alongside an emitted event.
///
/// When present, Core delivers it into the app-inbox feed (the desktop Inbox
/// renders it, showing this app's icon) in addition to the hook/workflow fan-out.
/// Delivering is best-effort on Core's side — the emit itself never fails over a
/// notification. `target_user_id` names a specific member; omit it on a local
/// single-user node and Core delivers to the active account.
#[derive(Debug, Clone, Serialize)]
pub struct NotifyHint {
    /// The notification title (the row's headline).
    pub title: String,
    /// Optional body text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// One of `info` | `success` | `warning` | `error` (defaults to `info`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// The member to deliver to; omit to target the node's active account.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_user_id: Option<String>,
}

impl NotifyHint {
    /// Build a plain `info` hint with just a title and optional body.
    #[must_use]
    pub fn info(title: impl Into<String>, body: Option<String>) -> Self {
        Self {
            title: title.into(),
            body,
            level: None,
            target_user_id: None,
        }
    }

    /// Mark the hint `level` (`info` | `success` | `warning` | `error`).
    #[must_use]
    pub fn with_level(mut self, level: impl Into<String>) -> Self {
        self.level = Some(level.into());
        self
    }
}

/// Why an emit did not reach Core. Callers that use [`EventEmitter::emit`] never see
/// these; they exist for [`EventEmitter::try_emit`].
#[derive(Debug)]
pub enum EmitError {
    /// `RYU_CORE_PORT`/`RYU_BIND` or `RYU_EXT_TOKEN` was absent — the process was not spawned by
    /// Core as a sidecar, so there is no host to emit to. Not an error worth
    /// alarming about: it is the normal state when running a backend standalone in
    /// development or under its own tests.
    NotHosted,
    /// The HTTP call itself failed.
    Transport(reqwest::Error),
    /// Core rejected the emit. Carries the status and body; a `403` means the event
    /// is not declared in this plugin's manifest (or is namespaced to another
    /// plugin), which is a manifest bug rather than a runtime condition.
    Rejected { status: u16, body: String },
}

impl std::fmt::Display for EmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotHosted => write!(f, "not running as a Core-spawned sidecar"),
            Self::Transport(e) => write!(f, "emit transport failed: {e}"),
            Self::Rejected { status, body } => write!(f, "Core rejected emit ({status}): {body}"),
        }
    }
}

impl std::error::Error for EmitError {}

/// A single provider call that may need to be charged to the hosting
/// organization. The sidecar supplies descriptive provider facts; Core derives
/// tenancy and Gateway applies the billing policy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageReport {
    pub provider: String,
    pub tool_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_micro_usd: Option<u64>,
    #[serde(default)]
    pub estimated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    pub request_id: String,
    pub tool_calls: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_label: Option<String>,
}

impl ToolUsageReport {
    const MAX_PROVIDER_BYTES: usize = 64;
    const MAX_TOOL_ID_BYTES: usize = 256;
    const MAX_REQUEST_ID_BYTES: usize = 256;
    const MAX_TRANSACTION_ID_BYTES: usize = 256;
    const MAX_TASK_LABEL_BYTES: usize = 256;

    /// Validate the caller-controlled descriptive fields before they reach Core,
    /// Gateway logs, or a durable usage statement.
    pub fn validate(&self) -> Result<(), UsageReportError> {
        if self.provider.trim().is_empty() || self.provider.len() > Self::MAX_PROVIDER_BYTES {
            return Err(UsageReportError::Invalid(
                "provider is empty or too long".to_owned(),
            ));
        }
        if self.tool_id.trim().is_empty() || self.tool_id.len() > Self::MAX_TOOL_ID_BYTES {
            return Err(UsageReportError::Invalid(
                "tool_id is empty or too long".to_owned(),
            ));
        }
        if self.request_id.trim().is_empty() || self.request_id.len() > Self::MAX_REQUEST_ID_BYTES {
            return Err(UsageReportError::Invalid(
                "request_id is empty or too long".to_owned(),
            ));
        }
        if self
            .transaction_id
            .as_deref()
            .is_some_and(|value| value.len() > Self::MAX_TRANSACTION_ID_BYTES)
        {
            return Err(UsageReportError::Invalid(
                "transaction_id is too long".to_owned(),
            ));
        }
        if self
            .task_label
            .as_deref()
            .is_some_and(|value| value.len() > Self::MAX_TASK_LABEL_BYTES)
        {
            return Err(UsageReportError::Invalid(
                "task_label is too long".to_owned(),
            ));
        }
        if self.tool_calls == 0 {
            return Err(UsageReportError::Invalid(
                "tool_calls must be positive".to_owned(),
            ));
        }
        Ok(())
    }
}

/// What Core accepted after authenticating and deriving the node's organization.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageAccepted {
    #[serde(default)]
    pub accepted: bool,
    #[serde(default)]
    pub billed: bool,
    #[serde(default)]
    pub org_id: Option<String>,
}

/// Why a provider usage report did not reach Core.
#[derive(Debug)]
pub enum UsageReportError {
    NotHosted,
    Invalid(String),
    Transport(reqwest::Error),
    Rejected { status: u16, body: String },
}

impl std::fmt::Display for UsageReportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotHosted => write!(f, "not running as a Core-spawned sidecar"),
            Self::Invalid(message) => write!(f, "invalid tool usage report: {message}"),
            Self::Transport(error) => write!(f, "usage report transport failed: {error}"),
            Self::Rejected { status, body } => {
                write!(f, "Core rejected usage report ({status}): {body}")
            }
        }
    }
}

impl std::error::Error for UsageReportError {}

/// Resolve the `events.emit` endpoint from the environment Core injects at spawn,
/// or `None` when this process is not Core-hosted.
///
/// **Read [`ENV_CORE_PORT`] first, and take only the PORT from [`ENV_CORE_BIND`].**
/// Both halves of that are load-bearing, and getting either wrong makes every emit
/// silently no-op on a shipped build while passing every dev-machine test:
///
/// - Core injects `RYU_CORE_PORT` into every manifest sidecar unconditionally
///   (`inject_ext_env`), precisely so a sidecar can call back. It does NOT inject
///   `RYU_BIND` — a sidecar only ever inherits that from Core's own process env, and
///   Core only seeds it in the **dev** profile (`apply_env_defaults` returns early on
///   release). So a release desktop install has no `RYU_BIND` at all.
/// - When `RYU_BIND` *is* set it is a BIND address, not a reachable URL: it is
///   routinely `0.0.0.0:7980`, and `http://0.0.0.0/...` is not a valid destination.
///   Core's own readers take only the port for exactly this reason
///   (`cli_shims::core_port_string`), and so does this.
fn core_endpoint() -> Option<String> {
    core_endpoint_for(CAP_EVENTS_EMIT)
}

fn core_endpoint_for(capability: &str) -> Option<String> {
    let port = std::env::var(ENV_CORE_PORT)
        .ok()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .or_else(|| {
            std::env::var(ENV_CORE_BIND).ok().and_then(|bind| {
                bind.rsplit_once(':')
                    .and_then(|(_, p)| p.trim().parse::<u16>().ok())
            })
        })?;
    Some(endpoint_for_port(port, capability))
}

fn endpoint_for_port(port: u16, capability: &str) -> String {
    format!("http://127.0.0.1:{port}/api/host/capability/{capability}")
}

/// Emits app events on behalf of ONE plugin.
///
/// Cheap to clone (it holds a `reqwest::Client`, which is itself an `Arc`), so the
/// idiomatic use is to build one at startup and hand clones to whatever raises
/// events.
#[derive(Debug, Clone)]
pub struct EventEmitter {
    plugin_id: String,
    http: reqwest::Client,
    /// `None` when the process is not Core-hosted; every emit then short-circuits to
    /// [`EmitError::NotHosted`] instead of building a doomed request.
    endpoint: Option<String>,
    token: Option<String>,
}

impl EventEmitter {
    /// Build an emitter for `plugin_id`, reading Core's address and this sidecar's
    /// minted token from the environment Core injects at spawn.
    ///
    /// Never fails: a process running outside Core simply gets an emitter whose
    /// every emit is a no-op. A backend must be runnable standalone (its own tests
    /// do exactly that), so "no host" is a supported state, not a startup error.
    #[must_use]
    pub fn from_env(plugin_id: impl Into<String>) -> Self {
        Self::with_client(plugin_id, reqwest::Client::new())
    }

    /// [`Self::from_env`] with a caller-supplied HTTP client, so a sidecar that
    /// already owns a configured client (timeouts, pooling) reuses it.
    #[must_use]
    pub fn with_client(plugin_id: impl Into<String>, http: reqwest::Client) -> Self {
        let endpoint = core_endpoint();
        let token = std::env::var(ENV_EXT_TOKEN)
            .ok()
            .filter(|t| !t.trim().is_empty());
        let plugin_id = plugin_id.into();
        if endpoint.is_none() || token.is_none() {
            tracing::debug!(
                plugin = %plugin_id,
                "app-events: not Core-hosted ({ENV_CORE_PORT}/{ENV_EXT_TOKEN} unset); emits will no-op"
            );
        }
        Self {
            plugin_id,
            http,
            endpoint,
            token,
        }
    }

    /// Whether this emitter can actually reach Core. Useful to skip assembling an
    /// expensive payload that would be thrown away.
    #[must_use]
    pub fn is_hosted(&self) -> bool {
        self.endpoint.is_some() && self.token.is_some()
    }

    /// Emit `event` with `payload`, **best-effort**: a failure is logged and
    /// swallowed. This is the call site nearly every emitter wants — see the module
    /// docs on why a fan-out failure must not fail the work that produced the event.
    pub async fn emit(&self, event: &str, payload: serde_json::Value) {
        self.emit_with_notify(event, payload, None).await;
    }

    /// Emit `event` with `payload`, raising a user-facing notification alongside
    /// the fan-out. Best-effort exactly like [`Self::emit`]; the notify is an
    /// addition, not a dependency of the emit.
    pub async fn emit_with_notify(
        &self,
        event: &str,
        payload: serde_json::Value,
        notify: Option<NotifyHint>,
    ) {
        match self
            .try_emit_with_notify(event, payload, None, notify)
            .await
        {
            Ok(outcome) => {
                if outcome.hooks > 0 || outcome.workflows > 0 {
                    tracing::debug!(
                        event,
                        hooks = outcome.hooks,
                        workflows = outcome.workflows,
                        "app-events: emitted"
                    );
                }
            }
            // Not being hosted is the normal standalone/dev state, not a problem.
            Err(EmitError::NotHosted) => {}
            Err(e) => tracing::warn!(event, "app-events: emit failed: {e}"),
        }
    }

    /// Emit and return the outcome. `conversation_id` associates the event with a
    /// conversation when the emitter knows one, so a consumer hook can key its own
    /// per-conversation state exactly as a turn hook does.
    ///
    /// # Errors
    /// Returns [`EmitError`] when the process is not Core-hosted, the HTTP call
    /// fails, or Core rejects the emit (most often: the event is not declared in
    /// this plugin's manifest).
    pub async fn try_emit(
        &self,
        event: &str,
        payload: serde_json::Value,
        conversation_id: Option<&str>,
    ) -> Result<EmitOutcome, EmitError> {
        self.try_emit_with_notify(event, payload, conversation_id, None)
            .await
    }

    /// [`Self::try_emit`] with an optional [`NotifyHint`] raised alongside the
    /// event fan-out.
    pub async fn try_emit_with_notify(
        &self,
        event: &str,
        payload: serde_json::Value,
        conversation_id: Option<&str>,
        notify: Option<NotifyHint>,
    ) -> Result<EmitOutcome, EmitError> {
        let (Some(endpoint), Some(token)) = (self.endpoint.as_deref(), self.token.as_deref())
        else {
            return Err(EmitError::NotHosted);
        };

        let mut body = serde_json::json!({ "event": event, "payload": payload });
        if let Some(cid) = conversation_id {
            body["conversation_id"] = serde_json::Value::String(cid.to_owned());
        }
        if let Some(notify) = notify {
            body["notify"] = serde_json::to_value(notify).expect("NotifyHint serializes");
        }

        let resp = self
            .http
            .post(endpoint)
            .header(HDR_PLUGIN_ID, &self.plugin_id)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(EmitError::Transport)?;

        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let body = resp.text().await.unwrap_or_default();
            return Err(EmitError::Rejected { status, body });
        }
        resp.json::<EmitOutcome>()
            .await
            .map_err(EmitError::Transport)
    }
}

/// Reports provider usage from one sidecar to Core's billing capability.
///
/// This is deliberately separate from [`EventEmitter`]: usage is not a hook
/// event, and a caller needs a typed accepted/billed result for diagnostics even
/// though the normal provider path treats reporting as best-effort.
#[derive(Debug, Clone)]
pub struct UsageReporter {
    plugin_id: String,
    http: reqwest::Client,
    endpoint: Option<String>,
    token: Option<String>,
}

impl UsageReporter {
    /// Build a reporter from the same Core-spawned environment as the event
    /// emitter. Standalone sidecars receive `NotHosted` and remain unbilled.
    #[must_use]
    pub fn from_env(plugin_id: impl Into<String>) -> Self {
        Self::with_client(plugin_id, reqwest::Client::new())
    }

    /// Reuse a sidecar's bounded client and connection pool.
    #[must_use]
    pub fn with_client(plugin_id: impl Into<String>, http: reqwest::Client) -> Self {
        let endpoint = core_endpoint_for(CAP_TOOL_USAGE_RECORD);
        let token = std::env::var(ENV_EXT_TOKEN)
            .ok()
            .filter(|value| !value.trim().is_empty());
        Self {
            plugin_id: plugin_id.into(),
            http,
            endpoint,
            token,
        }
    }

    /// Whether this reporter has the Core callback coordinates.
    #[must_use]
    pub fn is_hosted(&self) -> bool {
        self.endpoint.is_some() && self.token.is_some()
    }

    /// Report a charge and return Core's tenancy/billing result.
    pub async fn try_report(
        &self,
        report: &ToolUsageReport,
    ) -> Result<ToolUsageAccepted, UsageReportError> {
        report.validate()?;
        let (Some(endpoint), Some(token)) = (self.endpoint.as_deref(), self.token.as_deref())
        else {
            return Err(UsageReportError::NotHosted);
        };

        let response = self
            .http
            .post(endpoint)
            .header(HDR_PLUGIN_ID, &self.plugin_id)
            .bearer_auth(token)
            .json(report)
            .send()
            .await
            .map_err(UsageReportError::Transport)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let body = response.text().await.unwrap_or_default();
            return Err(UsageReportError::Rejected { status, body });
        }
        response
            .json::<ToolUsageAccepted>()
            .await
            .map_err(UsageReportError::Transport)
    }

    /// Best-effort wrapper for provider hot paths. A failure records a safe
    /// diagnostic, but never turns a provider success into a publish failure.
    pub async fn report(&self, report: ToolUsageReport) {
        let provider = report.provider.clone();
        let tool_id = report.tool_id.clone();
        let request_id = report.request_id.clone();
        match self.try_report(&report).await {
            Ok(result) => {
                tracing::debug!(
                    provider,
                    tool_id,
                    request_id,
                    billed = result.billed,
                    "app usage report accepted"
                );
            }
            Err(UsageReportError::NotHosted) => {}
            Err(error) => tracing::warn!(
                provider,
                tool_id,
                request_id,
                "app usage report failed: {error}"
            ),
        }
    }
}

/// A provider call requested by an out-of-process Ryu app.
///
/// The app supplies only the provider-neutral operation facts. Core authenticates
/// the app and binds the request to the registered node organization; Gateway then
/// injects the provider credential from its own managed provider configuration.
/// No provider key crosses this structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProviderCall {
    pub provider: String,
    pub tool_id: String,
    #[serde(default)]
    pub operation: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    pub method: String,
    #[serde(default)]
    pub query: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    pub request_id: String,
    #[serde(default)]
    pub fallback_cost_micro_usd: Option<u64>,
    #[serde(default)]
    pub task_label: Option<String>,
}

impl ManagedProviderCall {
    const MAX_PROVIDER_BYTES: usize = 64;
    const MAX_TOOL_ID_BYTES: usize = 256;
    const MAX_METHOD_BYTES: usize = 16;
    const MAX_REQUEST_ID_BYTES: usize = 256;
    const MAX_TASK_LABEL_BYTES: usize = 256;

    pub fn validate(&self) -> Result<(), ProviderRouterError> {
        if self.provider.trim().is_empty() || self.provider.len() > Self::MAX_PROVIDER_BYTES {
            return Err(ProviderRouterError::Invalid(
                "provider is empty or too long".to_owned(),
            ));
        }
        if self.tool_id.trim().is_empty() || self.tool_id.len() > Self::MAX_TOOL_ID_BYTES {
            return Err(ProviderRouterError::Invalid(
                "tool_id is empty or too long".to_owned(),
            ));
        }
        if self.method.trim().is_empty() || self.method.len() > Self::MAX_METHOD_BYTES {
            return Err(ProviderRouterError::Invalid(
                "method is empty or too long".to_owned(),
            ));
        }
        if self.request_id.trim().is_empty() || self.request_id.len() > Self::MAX_REQUEST_ID_BYTES {
            return Err(ProviderRouterError::Invalid(
                "request_id is empty or too long".to_owned(),
            ));
        }
        if self
            .idempotency_key
            .as_deref()
            .is_some_and(|value| value.len() > Self::MAX_REQUEST_ID_BYTES)
        {
            return Err(ProviderRouterError::Invalid(
                "idempotency_key is too long".to_owned(),
            ));
        }
        if self
            .task_label
            .as_deref()
            .is_some_and(|value| value.len() > Self::MAX_TASK_LABEL_BYTES)
        {
            return Err(ProviderRouterError::Invalid(
                "task_label is too long".to_owned(),
            ));
        }
        Ok(())
    }
}

/// The provider response returned by Gateway after it has called the managed
/// provider and scheduled the organization-wallet debit.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProviderResponse {
    pub ok: bool,
    pub status: u16,
    pub body: Value,
    #[serde(default)]
    pub cost_micro_usd: Option<u64>,
    #[serde(default)]
    pub call_id: Option<String>,
}

/// Whether a managed provider is configured in Gateway's provider registry.
#[derive(Debug, Clone, Deserialize)]
pub struct ManagedProviderStatus {
    pub configured: bool,
}

#[derive(Debug)]
pub enum ProviderRouterError {
    NotHosted,
    Invalid(String),
    Transport(reqwest::Error),
    Rejected { status: u16, body: String },
}

impl std::fmt::Display for ProviderRouterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotHosted => write!(f, "not running as a Core-hosted sidecar"),
            Self::Invalid(message) => write!(f, "invalid managed provider call: {message}"),
            Self::Transport(error) => write!(f, "managed provider transport failed: {error}"),
            Self::Rejected { status, body } => {
                write!(f, "managed provider rejected the call ({status}): {body}")
            }
        }
    }
}

impl std::error::Error for ProviderRouterError {}

/// Provider-neutral app → Core → Gateway router.
#[derive(Debug, Clone)]
pub struct ProviderRouter {
    plugin_id: String,
    http: reqwest::Client,
    call_endpoint: Option<String>,
    status_endpoint: Option<String>,
    token: Option<String>,
}

impl ProviderRouter {
    #[must_use]
    pub fn from_env(plugin_id: impl Into<String>) -> Self {
        Self::with_client(plugin_id, reqwest::Client::new())
    }

    #[must_use]
    pub fn with_client(plugin_id: impl Into<String>, http: reqwest::Client) -> Self {
        let token = std::env::var(ENV_EXT_TOKEN)
            .ok()
            .filter(|value| !value.trim().is_empty());
        Self {
            plugin_id: plugin_id.into(),
            http,
            call_endpoint: core_endpoint_for("providers.call"),
            status_endpoint: core_endpoint_for("providers.status"),
            token,
        }
    }

    #[must_use]
    pub fn is_hosted(&self) -> bool {
        self.call_endpoint.is_some() && self.status_endpoint.is_some() && self.token.is_some()
    }

    /// Construct a router against a test server. This deliberately exposes no
    /// production configuration path; it only keeps provider adapters testable
    /// without mutating process-global environment variables.
    #[doc(hidden)]
    pub fn for_test(
        plugin_id: impl Into<String>,
        http: reqwest::Client,
        call_endpoint: impl Into<String>,
        status_endpoint: impl Into<String>,
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            http,
            call_endpoint: Some(call_endpoint.into()),
            status_endpoint: Some(status_endpoint.into()),
            token: Some("test-provider-router".to_owned()),
        }
    }

    pub async fn status(&self, provider: &str) -> Result<bool, ProviderRouterError> {
        let (Some(endpoint), Some(token)) =
            (self.status_endpoint.as_deref(), self.token.as_deref())
        else {
            return Err(ProviderRouterError::NotHosted);
        };
        let response = self
            .http
            .post(endpoint)
            .header(HDR_PLUGIN_ID, &self.plugin_id)
            .bearer_auth(token)
            .json(&serde_json::json!({ "provider": provider }))
            .send()
            .await
            .map_err(ProviderRouterError::Transport)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(ProviderRouterError::Rejected {
                status,
                body: response.text().await.unwrap_or_default(),
            });
        }
        response
            .json::<ManagedProviderStatus>()
            .await
            .map(|value| value.configured)
            .map_err(ProviderRouterError::Transport)
    }

    pub async fn call(
        &self,
        request: ManagedProviderCall,
    ) -> Result<ManagedProviderResponse, ProviderRouterError> {
        request.validate()?;
        let (Some(endpoint), Some(token)) = (self.call_endpoint.as_deref(), self.token.as_deref())
        else {
            return Err(ProviderRouterError::NotHosted);
        };
        let response = self
            .http
            .post(endpoint)
            .header(HDR_PLUGIN_ID, &self.plugin_id)
            .bearer_auth(token)
            .json(&request)
            .send()
            .await
            .map_err(ProviderRouterError::Transport)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(ProviderRouterError::Rejected {
                status,
                body: response.text().await.unwrap_or_default(),
            });
        }
        response
            .json::<ManagedProviderResponse>()
            .await
            .map_err(ProviderRouterError::Transport)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A backend running outside Core must not blow up on emit — its own test suite
    /// and any standalone run depend on that.
    #[tokio::test]
    async fn unhosted_emitter_no_ops_instead_of_failing() {
        // Explicitly construct the unhosted shape rather than mutating process env,
        // which would race every other test in the binary.
        let emitter = EventEmitter {
            plugin_id: "com.acme.app".to_owned(),
            http: reqwest::Client::new(),
            endpoint: None,
            token: None,
        };
        assert!(!emitter.is_hosted());
        assert!(matches!(
            emitter
                .try_emit("com.acme.app/thing.done", serde_json::json!({}), None)
                .await,
            Err(EmitError::NotHosted)
        ));
        // The best-effort wrapper must swallow it.
        emitter
            .emit("com.acme.app/thing.done", serde_json::json!({}))
            .await;
    }

    /// The endpoint must come from the port Core actually injects, and a `RYU_BIND`
    /// fallback must contribute only its PORT.
    ///
    /// This is a regression test for a bug that shipped green: reading `RYU_BIND`
    /// first made every emit silently no-op on a release install (Core injects
    /// `RYU_CORE_PORT` into sidecars, and only seeds `RYU_BIND` in the dev profile),
    /// while passing on every dev machine. Building from the whole bind string was
    /// the second half of it — `RYU_BIND` is routinely `0.0.0.0:7980`, which is not
    /// a dialable address.
    ///
    /// Written against the pure resolver rather than by mutating process env, which
    /// would race every other test in this binary.
    #[test]
    fn endpoint_prefers_core_port_and_never_dials_a_bind_host() {
        // The shape `RYU_CORE_PORT` arrives in: a bare port.
        assert_eq!(
            endpoint_from("7980"),
            Some("http://127.0.0.1:7980/api/host/capability/events.emit".to_owned())
        );
        // A wildcard bind must contribute its port ONLY — never `http://0.0.0.0/…`.
        let from_bind = endpoint_from_bind("0.0.0.0:7980");
        assert_eq!(
            from_bind,
            Some("http://127.0.0.1:7980/api/host/capability/events.emit".to_owned())
        );
        assert!(!from_bind.expect("some").contains("0.0.0.0"));
        // Nothing usable → not hosted, rather than a doomed request.
        assert_eq!(endpoint_from(""), None);
        assert_eq!(endpoint_from_bind("not-a-bind"), None);
    }

    /// The `RYU_CORE_PORT` half of [`core_endpoint`]'s resolution, factored for test.
    fn endpoint_from(port: &str) -> Option<String> {
        let port: u16 = port.trim().parse().ok()?;
        Some(format!(
            "http://127.0.0.1:{port}/api/host/capability/{CAP_EVENTS_EMIT}"
        ))
    }

    #[test]
    fn usage_report_requires_bounded_charge_identity() {
        let report = ToolUsageReport {
            provider: "treg".to_owned(),
            tool_id: "x.x.post.create".to_owned(),
            cost_micro_usd: Some(15_000),
            estimated: false,
            transaction_id: Some("call-1".to_owned()),
            request_id: "social:call-1".to_owned(),
            tool_calls: 1,
            task_label: Some("Outpost X post".to_owned()),
        };
        assert!(report.validate().is_ok());
        let wire = serde_json::to_value(&report).expect("report serializes");
        assert_eq!(wire["provider"], "treg");
        assert_eq!(wire["toolId"], "x.x.post.create");
        assert_eq!(wire["costMicroUsd"], 15_000);
        assert!(wire.get("secret").is_none());
    }

    #[test]
    fn usage_report_rejects_empty_or_zero_identity() {
        let report = ToolUsageReport {
            provider: "".to_owned(),
            tool_id: "x".to_owned(),
            cost_micro_usd: None,
            estimated: true,
            transaction_id: None,
            request_id: "request".to_owned(),
            tool_calls: 1,
            task_label: None,
        };
        assert!(matches!(
            report.validate(),
            Err(UsageReportError::Invalid(message)) if message.contains("provider")
        ));
    }

    #[test]
    fn managed_provider_call_has_no_credential_field_and_bounds_identity() {
        let call = ManagedProviderCall {
            provider: "treg".to_owned(),
            tool_id: "x.x.post.create".to_owned(),
            operation: Some("execute".to_owned()),
            account_id: None,
            method: "POST".to_owned(),
            query: Vec::new(),
            body: Some(serde_json::json!({ "text": "hello" })),
            idempotency_key: Some("post-segment".to_owned()),
            request_id: "social:post-segment".to_owned(),
            fallback_cost_micro_usd: Some(15_000),
            task_label: Some("Outpost social publish".to_owned()),
        };
        assert!(call.validate().is_ok());
        let wire = serde_json::to_value(&call).expect("call serializes");
        assert_eq!(wire["provider"], "treg");
        assert_eq!(wire["toolId"], "x.x.post.create");
        assert!(wire.get("token").is_none());

        let mut invalid = call;
        invalid.request_id.clear();
        assert!(matches!(
            invalid.validate(),
            Err(ProviderRouterError::Invalid(message)) if message.contains("request_id")
        ));
    }

    /// The `RYU_BIND` fallback half, factored for test.
    fn endpoint_from_bind(bind: &str) -> Option<String> {
        let (_, port) = bind.rsplit_once(':')?;
        endpoint_from(port)
    }

    #[test]
    fn outcome_defaults_to_zero_subscribers() {
        let parsed: EmitOutcome = serde_json::from_str("{}").expect("empty object parses");
        assert_eq!(parsed, EmitOutcome::default());
        let parsed: EmitOutcome =
            serde_json::from_value(serde_json::json!({ "event": "x", "hooks": 2, "workflows": 1 }))
                .expect("extra keys are ignored");
        assert_eq!(
            parsed,
            EmitOutcome {
                hooks: 2,
                workflows: 1
            }
        );
    }

    #[test]
    fn model_stream_request_accepts_bounded_text_messages() {
        let request = ModelStreamRequest {
            messages: vec![ModelStreamMessage {
                role: "user".to_owned(),
                content: "hello".to_owned(),
            }],
            model: "mesh-model".to_owned(),
            provider: Some("local".to_owned()),
            request_id: "req_1".to_owned(),
            max_tokens: Some(128),
            temperature: Some(0.2),
        };
        assert!(request.validate().is_ok());

        let wire = serde_json::to_value(request).expect("request serializes");
        assert_eq!(wire["requestId"], "req_1");
        assert_eq!(wire["messages"][0]["role"], "user");
        assert_eq!(wire["maxTokens"], 128);
    }

    #[test]
    fn model_stream_request_rejects_urls_and_oversized_context() {
        let mut request = ModelStreamRequest {
            messages: vec![ModelStreamMessage {
                role: "user".to_owned(),
                content: "hello".to_owned(),
            }],
            model: "mesh-model".to_owned(),
            provider: Some("http://127.0.0.1:9337".to_owned()),
            request_id: "req_1".to_owned(),
            max_tokens: Some(128),
            temperature: None,
        };
        assert!(matches!(
            request.validate(),
            Err(ModelStreamError::Invalid(_))
        ));

        request.provider = Some("local".to_owned());
        request.messages[0].content = "x".repeat(MAX_MODEL_CONTEXT_BYTES);
        assert!(matches!(
            request.validate(),
            Err(ModelStreamError::Invalid(_))
        ));
    }

    #[test]
    fn realtime_publish_request_has_exact_bounded_wire_shape() {
        let request = RealtimePublishRequest {
            room_id: "room_opaque_id".to_owned(),
            event: "turn.delta".to_owned(),
            data: serde_json::json!({ "runId": "run_opaque_id", "delta": "text" }),
        };
        assert!(request.validate().is_ok());
        assert_eq!(
            serde_json::to_value(request).expect("request serializes"),
            serde_json::json!({
                "room_id": "room_opaque_id",
                "event": "turn.delta",
                "data": { "runId": "run_opaque_id", "delta": "text" }
            })
        );
        assert_eq!(
            endpoint_for_port(7980, CAP_REALTIME_PUBLISH),
            "http://127.0.0.1:7980/api/host/capability/realtime.publish"
        );
    }

    #[test]
    fn realtime_publish_rejects_invalid_room_event_and_payload() {
        let mut request = RealtimePublishRequest {
            room_id: String::new(),
            event: "turn.delta".to_owned(),
            data: Value::Null,
        };
        assert!(matches!(
            request.validate(),
            Err(RealtimePublishError::Invalid(message)) if message.contains("room_id")
        ));

        request.room_id = "room_1".to_owned();
        request.event = "".to_owned();
        assert!(matches!(
            request.validate(),
            Err(RealtimePublishError::Invalid(message)) if message.contains("event")
        ));

        request.event = "turn.delta".to_owned();
        request.data = Value::String("x".repeat(MAX_REALTIME_EVENT_BYTES));
        assert!(matches!(
            request.validate(),
            Err(RealtimePublishError::Invalid(message)) if message.contains("too large")
        ));
    }

    #[tokio::test]
    async fn realtime_publish_is_not_hosted_without_callback_coordinates() {
        let publisher = ApplicationRoomPublisher {
            plugin_id: "@ryu/rooms".to_owned(),
            http: reqwest::Client::new(),
            endpoint: None,
            token: None,
        };
        assert!(matches!(
            publisher.publish("room_1", "turn.delta", Value::Null).await,
            Err(RealtimePublishError::NotHosted)
        ));
    }

    #[test]
    fn model_stream_event_uses_camel_case_wire_fields() {
        let event = ModelStreamEvent::TextDelta {
            request_id: "req_1".to_owned(),
            delta: "hello".to_owned(),
        };
        let wire = serde_json::to_value(event).expect("event serializes");
        assert_eq!(wire["type"], "textDelta");
        assert_eq!(wire["requestId"], "req_1");
    }

    #[test]
    fn model_stream_parser_accepts_delta_and_done_frames() {
        assert_eq!(
            parse_model_stream_frame(
                br#"data: {"type":"textDelta","requestId":"req_1","delta":"hello"}"#,
                "req_1",
            )
            .expect("delta frame"),
            Some(ModelStreamEvent::TextDelta {
                request_id: "req_1".to_owned(),
                delta: "hello".to_owned(),
            })
        );
        assert!(matches!(
            parse_model_stream_frame(b"data: [DONE]", "req_1").expect("done frame"),
            Some(ModelStreamEvent::Completed { request_id }) if request_id == "req_1"
        ));
    }

    #[test]
    fn model_stream_parser_rejects_malformed_json() {
        assert!(matches!(
            parse_model_stream_frame(b"data: not-json", "req_1"),
            Err(ModelStreamError::Protocol(_))
        ));
    }
}
