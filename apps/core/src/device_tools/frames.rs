//! Turn-stream frames for device calls (design §1.3). Every data part carries a
//! stable `id`, so `/api/chat/stream/resume` replays only its latest state.
//! No frame carries the tool input or a nonce.

use serde_json::{json, Value};

use super::prompts::{ALLOW_ALWAYS, ALLOW_ONCE, DENY};

/// A frame the dispatcher emits; each plane renders it its own way.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DeviceUiEvent {
    /// A `data-<name>` part with a stable id.
    Data {
        name: String,
        id: String,
        data: Value,
    },
    /// `tool-input-available` with the redacted display input.
    ToolInput {
        tool_call_id: String,
        tool_name: String,
        display_input: Value,
    },
    /// `tool-output-available` with the redacted display result.
    ToolOutput {
        tool_call_id: String,
        display_result: Value,
        is_error: bool,
    },
}

/// Status states of `data-device-tool-status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeviceStatus {
    WaitingDevice,
    AwaitingApproval,
    AwaitingPermission,
    Claimed,
    Done,
    /// The wait window ended; the call is parked for Retry (P4).
    Parked,
    Expired,
    Cancelled,
}

impl DeviceStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::WaitingDevice => "waiting-device",
            Self::AwaitingApproval => "awaiting-approval",
            Self::AwaitingPermission => "awaiting-permission",
            Self::Claimed => "claimed",
            Self::Done => "done",
            Self::Parked => "parked",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Serialize a data part with its id as SSE bytes.
pub(crate) fn data_part_bytes(name: &str, id: &str, data: &Value) -> Vec<u8> {
    crate::sidecar::adapters::ui_chunk(&json!({
        "type": format!("data-{name}"),
        "id": id,
        "data": data,
    }))
}

fn option(id: &str, name: &str, kind: &str) -> Value {
    json!({ "optionId": id, "name": name, "kind": kind })
}

/// The permission card options, in the existing ACP shape.
pub(crate) fn permission_options(allow_always: bool) -> Value {
    let mut options = vec![option(ALLOW_ONCE, "Allow once", "allow_once")];
    if allow_always {
        options.push(option(ALLOW_ALWAYS, "Always allow", "allow_always"));
    }
    options.push(option(DENY, "Deny", "reject_once"));
    Value::Array(options)
}

pub(crate) struct PermissionCard<'a> {
    pub(crate) request_id: &'a str,
    pub(crate) tool_call_id: &'a str,
    pub(crate) title: &'a str,
    pub(crate) allow_always: bool,
    pub(crate) device_id: &'a str,
    pub(crate) device_label: &'a str,
    pub(crate) app: &'a str,
    pub(crate) tool: &'a str,
    pub(crate) on_device: bool,
    /// Only on an on-device card: the frozen input hash the target phone
    /// signs with its user-presence key (`POST /api/device-tools/confirm`).
    pub(crate) input_sha256: Option<&'a str>,
}

pub(crate) fn permission_card(card: &PermissionCard<'_>) -> DeviceUiEvent {
    let mut device = json!({
        "deviceId": card.device_id,
        "label": card.device_label,
        "app": card.app,
        "tool": card.tool,
        "requiresOnDeviceConfirmation": card.on_device,
    });
    if let (true, Some(hash)) = (card.on_device, card.input_sha256) {
        device["inputSha256"] = Value::String(hash.to_owned());
    }
    DeviceUiEvent::Data {
        name: "ryu-permission".to_owned(),
        id: card.request_id.to_owned(),
        data: json!({
            "requestId": card.request_id,
            "toolCall": { "toolCallId": card.tool_call_id, "title": card.title, "kind": "device" },
            "options": permission_options(card.allow_always),
            "device": device,
        }),
    }
}

pub(crate) struct RequestFrame<'a> {
    pub(crate) conversation_id: &'a str,
    pub(crate) tool_call_id: &'a str,
    pub(crate) tool: &'a str,
    pub(crate) app: &'a str,
    pub(crate) summary: &'a str,
    pub(crate) target_device_id: &'a str,
    pub(crate) device_label: &'a str,
    pub(crate) expires_at_ms: i64,
    pub(crate) resumable_until_ms: i64,
}

pub(crate) fn request_frame(frame: &RequestFrame<'_>) -> DeviceUiEvent {
    DeviceUiEvent::Data {
        name: "device-tool-request".to_owned(),
        id: format!("devreq-{}", frame.tool_call_id),
        data: json!({
            "conversationId": frame.conversation_id,
            "toolCallId": frame.tool_call_id,
            "tool": frame.tool,
            "app": frame.app,
            "summary": frame.summary,
            "targetDeviceId": frame.target_device_id,
            "deviceLabel": frame.device_label,
            "expiresAtMs": frame.expires_at_ms,
            "resumableUntilMs": frame.resumable_until_ms,
        }),
    }
}

pub(crate) struct NeedsPermission<'a> {
    pub(crate) conversation_id: &'a str,
    pub(crate) tool_call_id: &'a str,
    /// The canonical tool id (`device.<app>.<verb>`).
    pub(crate) tool: &'a str,
    pub(crate) target_device_id: &'a str,
    pub(crate) device_label: &'a str,
    pub(crate) app: &'a str,
    pub(crate) app_name: &'a str,
    pub(crate) denied: bool,
    pub(crate) expires_at_ms: i64,
    pub(crate) resumable_until_ms: i64,
}

pub(crate) fn needs_permission_frame(frame: &NeedsPermission<'_>) -> DeviceUiEvent {
    DeviceUiEvent::Data {
        name: "device-tool-permission".to_owned(),
        id: format!("devperm-{}", frame.tool_call_id),
        data: json!({
            "conversationId": frame.conversation_id,
            "toolCallId": frame.tool_call_id,
            "tool": frame.tool,
            "targetDeviceId": frame.target_device_id,
            "deviceLabel": frame.device_label,
            "app": frame.app,
            "appName": frame.app_name,
            "state": if frame.denied { "denied" } else { "undetermined" },
            "expiresAtMs": frame.expires_at_ms,
            "resumableUntilMs": frame.resumable_until_ms,
        }),
    }
}

pub(crate) fn status_frame(tool_call_id: &str, status: DeviceStatus) -> DeviceUiEvent {
    DeviceUiEvent::Data {
        name: "device-tool-status".to_owned(),
        id: format!("devstat-{tool_call_id}"),
        data: json!({ "toolCallId": tool_call_id, "state": status.as_str() }),
    }
}

/// What a waiting or parked status is about. Frames carry these structured
/// fields, never a ready-made sentence, so every client renders the status in
/// the user's language from its own catalog (only the model-facing envelope
/// keeps an English sentence).
pub(crate) struct StatusAbout<'a> {
    /// The catalog app id (`calendar`, `location`, ...).
    pub(crate) app: &'a str,
    /// The catalog's English app name, a fallback for clients without one.
    pub(crate) app_name: &'a str,
    /// The unquoted device label of the pinned target, when there is one.
    pub(crate) device_label: Option<&'a str>,
}

/// A status frame with the structured fields of [`StatusAbout`].
pub(crate) fn status_frame_about(
    tool_call_id: &str,
    status: DeviceStatus,
    about: &StatusAbout<'_>,
) -> DeviceUiEvent {
    let mut frame = status_frame(tool_call_id, status);
    if let DeviceUiEvent::Data { data, .. } = &mut frame {
        data["app"] = Value::String(about.app.to_owned());
        data["appName"] = Value::String(about.app_name.to_owned());
        if let Some(label) = about.device_label {
            data["deviceLabel"] = Value::String(label.to_owned());
        }
    }
    frame
}

/// `data-device-tool-status` in the `parked` state: the card shows Retry until
/// `resumableUntilMs` (design §1.6, Retry fallback).
pub(crate) fn parked_frame(
    tool_call_id: &str,
    about: &StatusAbout<'_>,
    resumable_until_ms: i64,
) -> DeviceUiEvent {
    let mut frame = status_frame_about(tool_call_id, DeviceStatus::Parked, about);
    if let DeviceUiEvent::Data { data, .. } = &mut frame {
        data["resumableUntilMs"] = Value::from(resumable_until_ms);
        data["retry"] = Value::Bool(true);
    }
    frame
}
