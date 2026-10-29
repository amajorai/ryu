//! Ryu Hardware Protocol (RHP) v1.1 — Rust mirror of the wire contract.
//!
//! This is the node-side implementation of the SAME contract defined in
//! `apps/hardware/PROTOCOL.md` §3 (control messages) and §6 (REST). The WebSocket
//! ingress (`apps/core/src/server/hardware_ws.rs`) (de)serializes these types on
//! each legacy TEXT frame and on each secure CONTROL record ([`crate::secure`]);
//! audio and JPEG payloads are not modeled here.
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
//!   - Fields new in v1.1 on existing messages are `Option` with
//!     `skip_serializing_if`, so legacy v1 JSON stays byte-identical.
//!
//! Inbound device messages should be parsed with [`parse_client_msg`], which
//! separates an unknown `type` (`unsupported_type`, the session continues) from a
//! malformed known one (`bad_json`).

use serde::{Deserialize, Serialize};

pub use crate::capability::{CapabilityRejection, ConfirmPolicy, RejectCode};
pub use crate::pair_crypto::SealedCredentials;

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
    /// v1.1, secure sessions only: the device's capability table. Each register
    /// replaces the whole table; `generation` is at least 1 and strictly
    /// increasing within a session. Descriptors are validated by
    /// [`crate::capability::validate_register`], so they stay raw JSON here.
    CapabilitiesRegister {
        generation: u32,
        capabilities: Vec<serde_json::Value>,
    },
    /// v1.1, secure sessions only: the outcome of a `capability_invoke`.
    CapabilityResult {
        request_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<CapabilityErrorBody>,
    },
}

/// Every `type` tag [`RhpClientMsg`] understands, for two-step parsing.
pub const CLIENT_MSG_TYPES: [&str; 10] = [
    "hello",
    "mode",
    "listen",
    "text",
    "abort",
    "camera_meta",
    "telemetry",
    "ping",
    "capabilities_register",
    "capability_result",
];

/// Why an inbound control message could not be parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientParseError {
    /// Not JSON, not an object, or no string `type`.
    BadJson,
    /// A well-formed message of a type this node does not know. The session
    /// answers `unsupported_type` and continues.
    UnknownType(String),
    /// A known type whose fields do not match (`bad_json`).
    Malformed { type_name: String, error: String },
}

impl ClientParseError {
    /// The encrypted (or legacy TEXT) error code for this failure.
    pub fn code(&self) -> &'static str {
        match self {
            ClientParseError::UnknownType(_) => "unsupported_type",
            ClientParseError::BadJson | ClientParseError::Malformed { .. } => "bad_json",
        }
    }
}

impl std::fmt::Display for ClientParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientParseError::BadJson => f.write_str("message is not a JSON object with a type"),
            ClientParseError::UnknownType(t) => write!(f, "unsupported message type {t:?}"),
            ClientParseError::Malformed { type_name, error } => {
                write!(f, "malformed {type_name} message: {error}")
            }
        }
    }
}

impl std::error::Error for ClientParseError {}

/// Parse one device control message in two steps: first to JSON, then on its
/// `type` tag, so an unknown type is distinguishable from a malformed known one.
pub fn parse_client_msg(text: &str) -> Result<RhpClientMsg, ClientParseError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| ClientParseError::BadJson)?;
    let type_name = value
        .as_object()
        .and_then(|object| object.get("type"))
        .and_then(serde_json::Value::as_str)
        .ok_or(ClientParseError::BadJson)?
        .to_string();
    if !CLIENT_MSG_TYPES.contains(&type_name.as_str()) {
        return Err(ClientParseError::UnknownType(type_name));
    }
    serde_json::from_value(value).map_err(|error| ClientParseError::Malformed {
        type_name,
        error: error.to_string(),
    })
}

/// The error half of a failed `capability_result`. Device codes are
/// `invalid_args`, `unknown_capability`, `stale_generation`, `busy`, `timeout`,
/// `unconfirmed`, `denied` and `internal`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityErrorBody {
    pub code: String,
    #[serde(default)]
    pub message: String,
}

/// The limits a secure `hello_ack` advertises.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapLimits {
    pub max_caps: u32,
    pub max_inflight: u32,
    pub max_result_bytes: u32,
}

impl CapLimits {
    /// The v1.1 limits (design §6.1).
    pub const V1_1: CapLimits = CapLimits {
        max_caps: crate::capability::MAX_CAPS as u32,
        max_inflight: crate::capability::MAX_INFLIGHT as u32,
        max_result_bytes: crate::capability::MAX_RESULT_BYTES as u32,
    };
}

/// The `proto` value a secure `hello_ack` carries.
pub const PROTO_V1_1: &str = "1.1";

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
        /// v1.1, secure sessions only: `"1.1"`. Absent on legacy sessions so the
        /// v1 JSON stays byte-identical.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        proto: Option<String>,
        /// v1.1, secure sessions only: the capability limits.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cap_limits: Option<CapLimits>,
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
    /// v1.1: the node's verdict on a `capabilities_register`.
    CapabilitiesAck {
        generation: u32,
        accepted: Vec<String>,
        rejected: Vec<CapabilityRejection>,
    },
    /// v1.1: run a device capability. `request_id` is
    /// `inv_<connection generation>_<counter>`; `generation` is the capability
    /// table generation the node validated `args` against.
    CapabilityInvoke {
        request_id: String,
        generation: u32,
        name: String,
        args: serde_json::Value,
        deadline_ms: u32,
    },
    /// v1.1: the device was revoked; it wipes its credentials and re-enters
    /// pairing. Sent only on secure sessions (legacy keeps `error{device_revoked}`).
    Unpaired,
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
    /// 1 for legacy (v1) pairing, 2 for v1.1 pairing v2.
    #[serde(default = "legacy_protocol_level")]
    pub protocol_level: u8,
    /// Whether the device's sessions are end-to-end secure (level 2 with a
    /// pinned static key).
    #[serde(default)]
    pub secure: bool,
    /// `sas` (the user compared the code) or `unverified` (the user could not).
    #[serde(default)]
    pub key_verification: Option<String>,
    /// `qr` or `ble`: how the app learned the device key.
    #[serde(default)]
    pub key_source: Option<String>,
    /// Fingerprint of the pinned device key (`xxxx-xxxx-xxxx-xxxx`).
    #[serde(default)]
    pub key_fingerprint: Option<String>,
    /// The node identity was reset after pairing; the device must be re-paired.
    #[serde(default)]
    pub needs_repair: bool,
    /// Live capabilities (empty while the device is offline).
    #[serde(default)]
    pub capabilities: Vec<DeviceCapabilitySummary>,
    /// The device's stored prefs, exactly as `PATCH` last replaced them (an empty
    /// object for a device nobody has changed). `PATCH` replaces prefs as a whole,
    /// so a client reads them here to change one key without dropping the rest.
    #[serde(default)]
    pub prefs: serde_json::Map<String, serde_json::Value>,
}

fn legacy_protocol_level() -> u8 {
    1
}

/// One live capability in a [`DeviceListItem`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceCapabilitySummary {
    pub name: String,
    pub description: String,
    pub sensitive: bool,
    pub confirm: ConfirmPolicy,
    /// Whether agents can see it under the device prefs.
    pub enabled: bool,
}

/// PATCH /api/hardware/devices/:id request body.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceUpdate {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prefs: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Pairing v2 REST (§5 / §6)
// ---------------------------------------------------------------------------

/// POST /api/hardware/pair/begin request body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairBeginRequest {
    pub device_id: String,
    /// Wire device type (`watch` | `necklace` | `desk`); validated by the handler
    /// so a bad value is a 400 `bad_request`, not an extractor rejection.
    pub device_type: String,
    /// Exactly 32 lowercase hex characters.
    pub pairing_nonce: String,
    /// The device static key, base64url (32 bytes).
    pub device_pub: String,
    /// The device commitment, base64url (32 bytes).
    pub device_commit: String,
    /// `qr` or `ble`.
    pub key_source: String,
    /// `sas_press`.
    pub policy: String,
}

/// POST /api/hardware/pair/begin response body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairBeginResponse {
    /// Fresh node-chosen id, base64url (16 bytes).
    pub pairing_id: String,
    /// The node static key, base64url (32 bytes).
    pub node_pub: String,
    pub node_fingerprint: String,
    /// Seconds until the pending pairing expires (180).
    pub expires_in: u32,
}

/// POST /api/hardware/pair/reveal request body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRevealRequest {
    pub pairing_id: String,
    /// The device's per-attempt random value, base64url (16 bytes).
    pub device_rand: String,
}

/// POST /api/hardware/pair/reveal response body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRevealResponse {
    /// The 6-digit code the user compares with the device.
    pub sas: String,
    /// `SHA256(T)`, base64url.
    pub transcript_hash: String,
    pub device_fingerprint: String,
}

/// Wi-Fi credentials for `/pair/confirm`. The Debug output redacts the password,
/// and the value is wiped on drop.
#[derive(
    Clone, PartialEq, Eq, Serialize, Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop,
)]
pub struct WifiCredentials {
    /// 1 to 32 UTF-8 bytes, no NUL.
    pub ssid: String,
    /// Empty (open network) or 8 to 63 UTF-8 bytes, no NUL.
    #[serde(default)]
    pub psk: String,
}

impl std::fmt::Debug for WifiCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WifiCredentials")
            .field("ssid", &self.ssid)
            .field("psk", &"<redacted>")
            .finish()
    }
}

/// POST /api/hardware/pair/confirm request body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairConfirmRequest {
    pub pairing_id: String,
    /// The device's `confirmed{tag}`, base64url (32 bytes).
    pub confirm_tag: String,
    /// `sas` when the codes matched, `unverified` for "I can't verify".
    pub key_verification: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wifi: Option<WifiCredentials>,
}

/// POST /api/hardware/pair/confirm response body. The Debug output redacts the
/// relay token.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairConfirmResponse {
    /// `rhr_` + 64 hex: the WS-only token the phone relay uses.
    pub relay_token: String,
    /// The credentials sealed to the device, base64url (`ct || tag`).
    pub sealed_credentials: String,
    pub device: DeviceListItem,
}

impl std::fmt::Debug for PairConfirmResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairConfirmResponse")
            .field("relay_token", &"<redacted>")
            .field("sealed_credentials", &self.sealed_credentials)
            .field("device", &self.device)
            .finish()
    }
}

/// POST /api/hardware/pair/cancel request body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairCancelRequest {
    pub pairing_id: String,
    /// Why the app cancelled (`mismatch` logs a security warning).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// POST /api/hardware/identity/reset response body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityResetResponse {
    pub node_fingerprint: String,
    /// The level-2 devices now marked `needs_repair`.
    pub devices_needing_repair: Vec<String>,
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
        assert_eq!(
            serde_json::to_string(&Mode::Ambient).unwrap(),
            "\"ambient\""
        );
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
            proto: None,
            cap_limits: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(!json.contains("ambient_session_id"), "{json}");
        // Legacy hello_ack stays byte-identical to v1.
        assert_eq!(
            json,
            r#"{"type":"hello_ack","session_id":"s1","tts":{"codec":"opus","sample_rate":24000,"frame_ms":60}}"#
        );
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
            protocol_level: 1,
            secure: false,
            key_verification: None,
            key_source: None,
            key_fingerprint: None,
            needs_repair: false,
            capabilities: Vec::new(),
            prefs: serde_json::Map::new(),
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"type\":\"desk\""), "{json}");
        assert!(json.contains("\"battery_pct\":null"), "{json}");
        // A v1 item (no new fields) still deserializes with the defaults.
        let legacy: DeviceListItem = serde_json::from_str(
            r#"{"device_id":"d1","type":"desk","name":"Desk","last_seen":null,"online":false,"battery_pct":null}"#,
        )
        .unwrap();
        assert_eq!(legacy.protocol_level, 1);
        assert!(!legacy.secure && legacy.capabilities.is_empty());
    }

    const NOISE: &str = include_str!("../tests/vectors/rhp_v1_1_noise.json");

    /// The JSON body of a vector record's CONTROL inner (strip type + flags).
    fn record_body(label: &str) -> String {
        let v: serde_json::Value = serde_json::from_str(NOISE).unwrap();
        let record = v["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["label"] == label)
            .unwrap();
        let inner = hex::decode(record["inner_hex"].as_str().unwrap()).unwrap();
        assert_eq!(&inner[..2], &[1, 0]);
        String::from_utf8(inner[2..].to_vec()).unwrap()
    }

    #[test]
    fn secure_hello_ack_is_byte_identical_to_vector() {
        let msg = RhpServerMsg::HelloAck {
            session_id: "hwses_test".into(),
            ambient_session_id: None,
            tts: AudioFormat {
                codec: "opus".into(),
                sample_rate: 24_000,
                frame_ms: 60,
            },
            proto: Some(PROTO_V1_1.into()),
            cap_limits: Some(CapLimits::V1_1),
        };
        assert_eq!(
            serde_json::to_string(&msg).unwrap(),
            record_body("hello_ack")
        );
    }

    #[test]
    fn v1_1_messages_roundtrip_against_vectors() {
        let invoke = RhpServerMsg::CapabilityInvoke {
            request_id: "inv_7_1".into(),
            generation: 1,
            name: "display.show_text".into(),
            args: serde_json::json!({"text": "Hi", "seconds": 5}),
            deadline_ms: 5000,
        };
        let body = record_body("capability_invoke");
        let as_value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(serde_json::to_value(&invoke).unwrap(), as_value);
        assert_eq!(serde_json::from_str::<RhpServerMsg>(&body).unwrap(), invoke);

        let result = parse_client_msg(&record_body("capability_result")).unwrap();
        assert_eq!(
            result,
            RhpClientMsg::CapabilityResult {
                request_id: "inv_7_1".into(),
                ok: true,
                result: Some(serde_json::json!({"shown": true})),
                error: None,
            }
        );
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            record_body("capability_result")
        );

        let register = parse_client_msg(&record_body("capabilities_register")).unwrap();
        match &register {
            RhpClientMsg::CapabilitiesRegister {
                generation,
                capabilities,
            } => {
                assert_eq!(*generation, 1);
                assert_eq!(capabilities.len(), 2);
            }
            other => panic!("expected capabilities_register, got {other:?}"),
        }
        assert!(matches!(
            parse_client_msg(&record_body("camera_meta")).unwrap(),
            RhpClientMsg::CameraMeta { bytes: 20_000, .. }
        ));

        let ack = RhpServerMsg::CapabilitiesAck {
            generation: 1,
            accepted: vec!["device.status".into()],
            rejected: vec![CapabilityRejection {
                name: "system.reboot".into(),
                code: RejectCode::Reserved,
            }],
        };
        assert_eq!(
            serde_json::to_string(&ack).unwrap(),
            r#"{"type":"capabilities_ack","generation":1,"accepted":["device.status"],"rejected":[{"name":"system.reboot","code":"reserved"}]}"#
        );
        assert_eq!(
            serde_json::to_string(&RhpServerMsg::Unpaired).unwrap(),
            r#"{"type":"unpaired"}"#
        );
        let failed: RhpClientMsg = serde_json::from_str(
            r#"{"type":"capability_result","request_id":"inv_1_2","ok":false,"error":{"code":"busy","message":"later"}}"#,
        )
        .unwrap();
        assert!(matches!(
            failed,
            RhpClientMsg::CapabilityResult { ok: false, error: Some(ref e), .. } if e.code == "busy"
        ));
    }

    #[test]
    fn parse_client_msg_separates_unknown_from_malformed() {
        assert_eq!(parse_client_msg("not json"), Err(ClientParseError::BadJson));
        assert_eq!(parse_client_msg("[1]"), Err(ClientParseError::BadJson));
        assert_eq!(
            parse_client_msg(r#"{"type":5}"#),
            Err(ClientParseError::BadJson)
        );
        let unknown = parse_client_msg(r#"{"type":"future_thing","x":1}"#).unwrap_err();
        assert_eq!(
            unknown,
            ClientParseError::UnknownType("future_thing".into())
        );
        assert_eq!(unknown.code(), "unsupported_type");
        let malformed = parse_client_msg(r#"{"type":"telemetry","battery_pct":"x"}"#).unwrap_err();
        assert!(
            matches!(malformed, ClientParseError::Malformed { ref type_name, .. } if type_name == "telemetry")
        );
        assert_eq!(malformed.code(), "bad_json");
        assert_eq!(
            parse_client_msg(r#"{"type":"ping"}"#),
            Ok(RhpClientMsg::Ping)
        );
    }

    #[test]
    fn wifi_debug_redacts_psk() {
        let wifi = WifiCredentials {
            ssid: "HomeNet".into(),
            psk: "correct horse".into(),
        };
        let debug = format!("{wifi:?}");
        assert!(
            debug.contains("HomeNet") && !debug.contains("correct horse"),
            "{debug}"
        );
        let req: PairConfirmRequest = serde_json::from_str(
            r#"{"pairing_id":"p","confirm_tag":"t","key_verification":"sas","wifi":{"ssid":"s","psk":"12345678"}}"#,
        )
        .unwrap();
        assert!(!format!("{req:?}").contains("12345678"));
    }
}
