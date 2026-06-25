//! Ryu Hardware Protocol (RHP) v1 — Rust mirror of the wire contract.
//!
//! This is the node-side implementation of the SAME contract defined in
//! `apps/hardware/PROTOCOL.md` §3. The WebSocket handler
//! (`apps/core/src/server/hardware_ws.rs`, wired in a later phase) (de)serializes
//! these types on each TEXT frame; BINARY frames carry Opus/JPEG payloads and are
//! not modeled here.
//!
//! Keep this in lockstep with the two sibling implementations:
//!   - C    (firmware): apps/hardware/firmware/shared/protocol/include/rhp_protocol.h
//!   - TS   (relay):    packages/protocol/src/hardware.ts
//!
//! Message `type` strings and field names are NORMATIVE. The serde attributes
//! below are chosen so the emitted JSON matches the spec exactly:
//!   - `#[serde(tag = "type", rename_all = "snake_case")]` makes the enum a
//!     `{ "type": "..." }`-tagged union; snake_case yields `camera_meta`,
//!     `hello_ack`, `tts_start`, `chat_delta`, etc.
//!   - `Stt` renames to `stt`, `TtsStart`/`TtsEnd` to `tts_start`/`tts_end`.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// Physical device class. Wire: `watch` | `necklace` | `desk`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceType {
    Watch,
    Necklace,
    Desk,
}

/// Wire string for a [`DeviceType`] (mirrors C `rhp_device_type_str`). Used by
/// the SQLite registry, which stores the device class as its wire token rather
/// than re-deriving it via serde.
pub fn device_type_str(device_type: DeviceType) -> &'static str {
    match device_type {
        DeviceType::Watch => "watch",
        DeviceType::Necklace => "necklace",
        DeviceType::Desk => "desk",
    }
}

/// Parse a [`DeviceType`] from its wire string (mirrors C `rhp_device_type_parse`).
/// Returns `None` for any unrecognized value.
pub fn parse_device_type(s: &str) -> Option<DeviceType> {
    match s {
        "watch" => Some(DeviceType::Watch),
        "necklace" => Some(DeviceType::Necklace),
        "desk" => Some(DeviceType::Desk),
        _ => None,
    }
}

impl DeviceType {
    /// Whether this device class captures ambient audio for the 24/7 meeting
    /// pipeline (PROTOCOL.md §4.2). The necklace + desk are always-on listeners;
    /// the watch is interactive-only. The device's advertised `caps.mic` still
    /// gates it at runtime — this is the class-level default.
    pub fn ambient_capable(self) -> bool {
        matches!(self, DeviceType::Necklace | DeviceType::Desk)
    }
}

/// Device operating mode. Wire: `idle` | `chat` | `ambient`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Idle,
    Chat,
    Ambient,
}

/// Chat-turn boundary marker. Wire: `start` | `stop`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListenState {
    Start,
    Stop,
}

/// Face/emotion state driving the "Island eyes" renderer.
/// Wire: `neutral` | `listening` | `thinking` | `happy` | `sad` | `surprised`
///     | `speaking`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Emotion {
    Neutral,
    Listening,
    Thinking,
    Happy,
    Sad,
    Surprised,
    Speaking,
}

/// Display surface a `display` message targets. Wire: `eink` | `lcd`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    Eink,
    Lcd,
}

// ---------------------------------------------------------------------------
// Shared sub-structs
// ---------------------------------------------------------------------------

/// Audio format descriptor (mic uplink in `hello`, TTS downlink in `hello_ack`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioFormat {
    /// Always `"opus"` in v1.
    pub codec: String,
    /// 16000 (mic uplink) or 24000 (TTS downlink).
    pub sample_rate: u32,
    /// 60 ms frames.
    pub frame_ms: u32,
}

/// Capability profile a device advertises in `hello`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caps {
    pub display: bool,
    pub camera: bool,
    pub speaker: bool,
    pub mic: bool,
}

// ---------------------------------------------------------------------------
// Client -> Server (§3.1)
// ---------------------------------------------------------------------------

/// Every control message a device/relay sends to the node, tagged on `type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RhpClientMsg {
    /// First frame on connect; identifies the device and its capabilities.
    Hello {
        device_id: String,
        device_type: DeviceType,
        fw_version: String,
        /// True if tunneled via the phone (Mode A relay).
        relay: bool,
        audio: AudioFormat,
        caps: Caps,
    },
    /// Device operating-mode change.
    Mode { value: Mode },
    /// Chat-turn boundary.
    Listen { state: ListenState },
    /// Typed/derived text input (fallback path).
    Text { content: String },
    /// Barge-in: stop current TTS + generation.
    Abort,
    /// Announces that the next BINARY frame is a JPEG of these dimensions.
    CameraMeta {
        w: u32,
        h: u32,
        fmt: String,
        bytes: u32,
    },
    /// Periodic device telemetry.
    Telemetry {
        battery_pct: i32,
        rssi: i32,
        charging: bool,
    },
    /// Liveness probe.
    Ping,
}

// ---------------------------------------------------------------------------
// Server -> Client (§3.2)
// ---------------------------------------------------------------------------

/// Every control message the node sends to a device/relay, tagged on `type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RhpServerMsg {
    /// Acknowledges `hello`; carries session ids and the TTS downlink format.
    HelloAck {
        session_id: String,
        /// Present (long-running meeting id) only if the device is ambient-capable.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        ambient_session_id: Option<String>,
        tts: AudioFormat,
    },
    /// Live transcript of the user's speech (display it). `final_` serializes as
    /// the wire name `final` (a Rust keyword), via the explicit field rename.
    Stt {
        text: String,
        #[serde(rename = "final")]
        final_: bool,
    },
    /// One streamed assistant-token chunk.
    ChatDelta { text: String },
    /// End of the streamed assistant turn.
    ChatEnd { conversation_id: String },
    /// Face state change.
    Emotion { value: Emotion },
    /// TTS audio is about to stream as BINARY Opus frames.
    TtsStart,
    /// End of the TTS audio stream.
    TtsEnd,
    /// An ambient chunk was transcribed and indexed.
    AmbientAck { segment_id: String },
    /// An ambient chunk was skipped (e.g. silence).
    AmbientSkip { reason: String },
    /// Desk ambient/e-ink display update. `payload` is widget-specific JSON.
    Display {
        surface: Surface,
        widget: String,
        payload: serde_json::Value,
    },
    /// Protocol or processing error.
    Error { code: String, message: String },
    /// Liveness response.
    Pong,
}

// ---------------------------------------------------------------------------
// Pairing & device-registry REST (§6)
// ---------------------------------------------------------------------------

/// POST /api/hardware/pair request body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRequest {
    pub device_id: String,
    pub pairing_nonce: String,
    pub device_type: DeviceType,
}

/// POST /api/hardware/pair response body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairResponse {
    /// Per-device Bearer token used on the WS upgrade.
    pub device_token: String,
    /// The node's reachable URL the device should connect to.
    pub node_url: String,
}

/// One entry in GET /api/hardware/devices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceListItem {
    pub device_id: String,
    #[serde(rename = "type")]
    pub device_type: DeviceType,
    pub name: String,
    /// Epoch milliseconds of last activity, or null if never seen.
    pub last_seen: Option<i64>,
    pub online: bool,
    /// Latest reported battery percent, or null if unknown.
    pub battery_pct: Option<i32>,
}

/// PATCH /api/hardware/devices/:id request body.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceUpdate {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prefs: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_wire_strings() {
        assert_eq!(
            serde_json::to_string(&DeviceType::Necklace).unwrap(),
            "\"necklace\""
        );
        assert_eq!(serde_json::to_string(&Mode::Ambient).unwrap(), "\"ambient\"");
        assert_eq!(
            serde_json::to_string(&Emotion::Surprised).unwrap(),
            "\"surprised\""
        );
        assert_eq!(serde_json::to_string(&Surface::Eink).unwrap(), "\"eink\"");
    }

    #[test]
    fn client_hello_roundtrips() {
        let raw = r#"{"type":"hello","device_id":"rhw_ab12","device_type":"watch","fw_version":"0.1.0","relay":false,"audio":{"codec":"opus","sample_rate":16000,"frame_ms":60},"caps":{"display":true,"camera":false,"speaker":true,"mic":true}}"#;
        let msg: RhpClientMsg = serde_json::from_str(raw).unwrap();
        match &msg {
            RhpClientMsg::Hello {
                device_id,
                device_type,
                ..
            } => {
                assert_eq!(device_id, "rhw_ab12");
                assert_eq!(*device_type, DeviceType::Watch);
            }
            _ => panic!("expected hello"),
        }
    }

    #[test]
    fn camera_meta_tag_is_snake_case() {
        let msg = RhpClientMsg::CameraMeta {
            w: 640,
            h: 480,
            fmt: "jpeg".into(),
            bytes: 18_234,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"camera_meta\""), "{json}");
    }

    #[test]
    fn server_stt_final_renames_to_keyword() {
        let msg = RhpServerMsg::Stt {
            text: "hello".into(),
            final_: true,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"stt\""), "{json}");
        assert!(json.contains("\"final\":true"), "{json}");
    }

    #[test]
    fn server_tts_and_pong_have_no_payload() {
        assert_eq!(
            serde_json::to_string(&RhpServerMsg::TtsStart).unwrap(),
            "{\"type\":\"tts_start\"}"
        );
        assert_eq!(
            serde_json::to_string(&RhpServerMsg::Pong).unwrap(),
            "{\"type\":\"pong\"}"
        );
    }

    #[test]
    fn hello_ack_omits_absent_ambient_session() {
        let msg = RhpServerMsg::HelloAck {
            session_id: "s1".into(),
            ambient_session_id: None,
            tts: AudioFormat {
                codec: "opus".into(),
                sample_rate: 24_000,
                frame_ms: 60,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(!json.contains("ambient_session_id"), "{json}");
    }

    #[test]
    fn device_list_item_uses_type_key() {
        let item = DeviceListItem {
            device_id: "d1".into(),
            device_type: DeviceType::Desk,
            name: "Desk".into(),
            last_seen: Some(1_700_000_000_000),
            online: true,
            battery_pct: None,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"type\":\"desk\""), "{json}");
        assert!(json.contains("\"battery_pct\":null"), "{json}");
    }
}
