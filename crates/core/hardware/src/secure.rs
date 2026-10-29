//! RHN: the RHP v1.1 secure session layer (design §4.2 to §4.8), transport-agnostic.
//!
//! A `Noise_XX_25519_AESGCM_SHA256` session ([`crate::noise`]) runs inside the
//! existing `/api/hardware/ws` WebSocket. Each outer frame is one WS BINARY message
//! (Mode B) or one reassembled BLE message (Mode A); this module never touches a
//! socket, so Core's ingress (`apps/core/src/server/hardware_ws.rs`) drives it over
//! axum while tests and the C interop drive it over channels and pipes.
//!
//! Outer frames (byte 0):
//!
//! | byte0 | Name | Layout |
//! |---|---|---|
//! | 0x01 | HS1 (device to node) | `01 ver=01 suite=01 flags=00 e(32)`, 36 bytes |
//! | 0x02 | HS2 (node to device) | `02 e(32) enc(s)(48) enc(01 00)(18)`, 99 bytes |
//! | 0x03 | HS3 (device to node) | `03 enc(s)(48) enc(hello JSON)`, hello at most 2048 |
//! | 0x04 | DATA (both) | `04 AEAD(k, n, ad = "", inner)`, at most 16401 bytes |
//! | 0x7F | PLAIN_ERROR (node to device) | `7F ascii[a-z0-9_]{1,32}` |
//!
//! The DATA plaintext is `type:u8 flags:u8 body` (at most 16384 bytes). CONTROL
//! (65536 logical bytes) and BLOB (262144) may be fragmented with the MORE flag;
//! fragments of one message are contiguous in their direction. AUDIO, REKEY and
//! KEEPALIVE are single records. Any violation, AEAD failure or limit breach is
//! fatal: the half is poisoned and the session must close (there is no resync).
//!
//! The node is the responder ([`ServerHandshake`]); [`ClientHandshake`] is the
//! device role, used by Core's ingress tests and the C interop test. After the
//! handshake each side owns a [`SendHalf`] and a [`RecvHalf`] that can live on two
//! different tasks.

use std::time::{Duration, Instant};

use subtle::ConstantTimeEq;

use crate::identity::NodeIdentity;
use crate::noise::{self, CipherState, Initiator, NoiseError, Responder};

// ---------------------------------------------------------------------------
// Constants (design §4.2, §4.6, §4.7)
// ---------------------------------------------------------------------------

/// HS1 outer type.
pub const OUT_HS1: u8 = 0x01;
/// HS2 outer type.
pub const OUT_HS2: u8 = 0x02;
/// HS3 outer type.
pub const OUT_HS3: u8 = 0x03;
/// DATA outer type.
pub const OUT_DATA: u8 = 0x04;
/// PLAIN_ERROR outer type.
pub const OUT_PLAIN_ERROR: u8 = 0x7F;

/// RHN version byte in HS1 and the prologue.
pub const RHN_VERSION: u8 = 0x01;
/// Suite byte (`Noise_XX_25519_AESGCM_SHA256`).
pub const RHN_SUITE: u8 = 0x01;
/// Flags byte (none defined).
pub const RHN_FLAGS: u8 = 0x00;
/// The HS2 payload: minor version 1, flags 0.
pub const HS2_PAYLOAD: [u8; 2] = [0x01, 0x00];
/// The minimum minor version a device accepts in HS2.
pub const MIN_MINOR: u8 = 0x01;
/// The prologue label (`"ryu-rhp/1.1" 0x00`).
pub const PROLOGUE_LABEL: &[u8] = b"ryu-rhp/1.1\x00";
/// Longest device id bound in the prologue.
pub const MAX_DEVICE_ID_LEN: usize = 63;

/// Exact HS1 length.
pub const HS1_LEN: usize = 4 + noise::MSG1_LEN;
/// Exact HS2 length.
pub const HS2_LEN: usize = 1 + noise::msg2_len(HS2_PAYLOAD.len());
/// Longest hello JSON carried in HS3.
pub const MAX_HELLO_LEN: usize = 2048;
/// Shortest HS3 (empty hello).
pub const HS3_MIN_LEN: usize = 1 + noise::msg3_len(0);
/// Longest HS3.
pub const HS3_MAX_LEN: usize = 1 + noise::msg3_len(MAX_HELLO_LEN);

/// Largest DATA inner plaintext (`type + flags + body`).
pub const MAX_INNER: usize = 16_384;
/// Largest DATA record body.
pub const MAX_BODY: usize = MAX_INNER - 2;
/// Largest DATA outer frame.
pub const MAX_DATA_FRAME: usize = 1 + MAX_INNER + noise::TAG_LEN;
/// Smallest DATA outer frame (empty body).
pub const MIN_DATA_FRAME: usize = 1 + 2 + noise::TAG_LEN;
/// Longest PLAIN_ERROR code.
pub const MAX_PLAIN_ERROR_CODE: usize = 32;

/// Inner type: one RHP JSON control message (may be fragmented).
pub const INNER_CONTROL: u8 = 1;
/// Inner type: one Opus packet (never fragmented).
pub const INNER_AUDIO: u8 = 2;
/// Inner type: JPEG bytes after a `camera_meta` (device to node; fragmented).
pub const INNER_BLOB: u8 = 3;
/// Inner type: rotate the key after this record (empty).
pub const INNER_REKEY: u8 = 4;
/// Inner type: liveness (empty).
pub const INNER_KEEPALIVE: u8 = 5;
/// Inner flag bit 0: more fragments follow. Bits 1 to 7 must be zero.
pub const FLAG_MORE: u8 = 0x01;

/// Largest logical CONTROL message.
pub const MAX_CONTROL_LEN: usize = 65_536;
/// Largest logical BLOB.
pub const MAX_BLOB_LEN: usize = 262_144;

/// A sender rekeys at a message boundary after this many records...
pub const REKEY_AFTER_RECORDS: u64 = 65_535;
/// ...or after this long.
pub const REKEY_AFTER: Duration = Duration::from_secs(600);
/// A receiver fails with `rekey_overdue` beyond this many records without a rekey...
pub const REKEY_OVERDUE_RECORDS: u64 = 131_072;
/// ...or beyond this long (checked when a non-REKEY record arrives).
pub const REKEY_OVERDUE: Duration = Duration::from_secs(1_200);
/// A session closes when a direction's nonce reaches 2^32.
pub const MAX_RECORDS: u64 = 1 << 32;

/// Each handshake step waits at most this long.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The device sends KEEPALIVE after this long with nothing sent.
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);
/// The node closes a secure session after this long with no inbound record.
pub const NODE_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// The node closes secure sessions older than this (`session_expired`).
pub const MAX_SESSION_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// PLAIN_ERROR and encrypted error codes (design §4.8).
pub mod codes {
    pub const UNSUPPORTED_VERSION: &str = "unsupported_version";
    pub const BAD_FRAME: &str = "bad_frame";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const REPAIR_REQUIRED: &str = "repair_required";
    pub const RATE_LIMITED: &str = "rate_limited";
    pub const NODE_IDENTITY_UNAVAILABLE: &str = "node_identity_unavailable";
    pub const HANDSHAKE_TIMEOUT: &str = "handshake_timeout";
    pub const HANDSHAKE_FAILED: &str = "handshake_failed";
    pub const BAD_HELLO: &str = "bad_hello";
    pub const REKEY_OVERDUE: &str = "rekey_overdue";
    pub const SESSION_EXPIRED: &str = "session_expired";
    pub const SESSION_SUPERSEDED: &str = "session_superseded";
    pub const UNSUPPORTED_TYPE: &str = "unsupported_type";
    pub const BAD_JSON: &str = "bad_json";
    pub const CAPABILITIES_REJECTED: &str = "capabilities_rejected";
    pub const CAPABILITIES_REQUIRE_SECURE_SESSION: &str = "capabilities_require_secure_session";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why an RHN operation failed. Every error is fatal for the half (or handshake)
/// that produced it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecureError {
    /// A frame had the wrong outer type or length.
    BadFrame,
    /// HS1 announced a version, suite or flags this node does not speak (or the
    /// HS2 minor is too old, on the device side).
    UnsupportedVersion,
    /// The device_id is not `^[A-Za-z0-9_-]{1,63}$`.
    InvalidDeviceId,
    /// An AEAD check failed (handshake or transport).
    Decrypt,
    /// The peer sent a low-order key.
    LowOrder,
    /// The peer's static key is not the pinned one.
    PinMismatch,
    /// The hello is too long (an oversized HS3, or a device-side hello over
    /// [`MAX_HELLO_LEN`]). Always pre-session, so it maps to `handshake_failed`;
    /// the encrypted `bad_hello` code is sent by the caller after HS3.
    BadHello,
    /// A size limit was exceeded.
    Limit(&'static str),
    /// The peer went too long without rekeying.
    RekeyOverdue,
    /// The direction's nonce reached 2^32.
    NonceExhausted,
    /// A framing rule was violated.
    Protocol(&'static str),
    /// This half already failed.
    Poisoned,
}

impl SecureError {
    /// The design §4.8 code for this failure. Pre-session (handshake) failures
    /// map to PLAIN_ERROR codes only; transport failures map to the encrypted
    /// codes where one exists (an AEAD failure in transport closes without a
    /// meaningful message).
    pub fn code(self) -> &'static str {
        match self {
            SecureError::BadFrame | SecureError::Protocol(_) | SecureError::Limit(_) => {
                codes::BAD_FRAME
            }
            SecureError::UnsupportedVersion => codes::UNSUPPORTED_VERSION,
            SecureError::InvalidDeviceId | SecureError::PinMismatch => codes::UNAUTHORIZED,
            SecureError::Decrypt
            | SecureError::LowOrder
            | SecureError::Poisoned
            | SecureError::BadHello => codes::HANDSHAKE_FAILED,
            SecureError::RekeyOverdue => codes::REKEY_OVERDUE,
            SecureError::NonceExhausted => codes::SESSION_EXPIRED,
        }
    }
}

impl std::fmt::Display for SecureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecureError::BadFrame => f.write_str("rhn: bad frame"),
            SecureError::UnsupportedVersion => f.write_str("rhn: unsupported version"),
            SecureError::InvalidDeviceId => f.write_str("rhn: invalid device_id"),
            SecureError::Decrypt => f.write_str("rhn: AEAD authentication failed"),
            SecureError::LowOrder => f.write_str("rhn: low-order key"),
            SecureError::PinMismatch => f.write_str("rhn: static key does not match the pin"),
            SecureError::BadHello => f.write_str("rhn: bad hello"),
            SecureError::Limit(what) => write!(f, "rhn: limit exceeded: {what}"),
            SecureError::RekeyOverdue => f.write_str("rhn: peer rekey overdue"),
            SecureError::NonceExhausted => f.write_str("rhn: nonce exhausted"),
            SecureError::Protocol(what) => write!(f, "rhn: protocol violation: {what}"),
            SecureError::Poisoned => f.write_str("rhn: session already failed"),
        }
    }
}

impl std::error::Error for SecureError {}

impl From<NoiseError> for SecureError {
    fn from(error: NoiseError) -> Self {
        match error {
            NoiseError::Decrypt => SecureError::Decrypt,
            NoiseError::LowOrder => SecureError::LowOrder,
            NoiseError::BadLength | NoiseError::State => SecureError::BadFrame,
            NoiseError::Poisoned => SecureError::Poisoned,
            NoiseError::NonceExhausted => SecureError::NonceExhausted,
        }
    }
}

/// Why an HS1 was refused (the PLAIN_ERROR to send).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hs1Error {
    /// Not an HS1, or the wrong length.
    BadFrame,
    /// Version, suite or flags are not `01/01/00`.
    UnsupportedVersion,
}

impl Hs1Error {
    /// The PLAIN_ERROR code.
    pub fn code(self) -> &'static str {
        match self {
            Hs1Error::BadFrame => codes::BAD_FRAME,
            Hs1Error::UnsupportedVersion => codes::UNSUPPORTED_VERSION,
        }
    }
}

// ---------------------------------------------------------------------------
// Prologue, HS1, PLAIN_ERROR
// ---------------------------------------------------------------------------

/// Whether a device id matches `^[A-Za-z0-9_-]{1,63}$`.
pub fn is_valid_device_id(device_id: &str) -> bool {
    !device_id.is_empty()
        && device_id.len() <= MAX_DEVICE_ID_LEN
        && device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The Noise prologue: `"ryu-rhp/1.1" 0x00 ver suite flags u8(len) device_id`.
pub fn prologue(device_id: &str) -> Result<Vec<u8>, SecureError> {
    if !is_valid_device_id(device_id) {
        return Err(SecureError::InvalidDeviceId);
    }
    let mut out = Vec::with_capacity(PROLOGUE_LABEL.len() + 4 + device_id.len());
    out.extend_from_slice(PROLOGUE_LABEL);
    out.extend_from_slice(&[RHN_VERSION, RHN_SUITE, RHN_FLAGS]);
    out.push(u8::try_from(device_id.len()).map_err(|_| SecureError::InvalidDeviceId)?);
    out.extend_from_slice(device_id.as_bytes());
    Ok(out)
}

/// Check an HS1 frame: exactly 36 bytes with ver/suite/flags `01/01/00`.
pub fn validate_hs1(frame: &[u8]) -> Result<(), Hs1Error> {
    if frame.first() != Some(&OUT_HS1) || frame.len() < 4 {
        return Err(Hs1Error::BadFrame);
    }
    if frame[1..4] != [RHN_VERSION, RHN_SUITE, RHN_FLAGS] {
        return Err(Hs1Error::UnsupportedVersion);
    }
    if frame.len() != HS1_LEN {
        return Err(Hs1Error::BadFrame);
    }
    Ok(())
}

fn is_valid_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= MAX_PLAIN_ERROR_CODE
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A PLAIN_ERROR frame (`7F code`). A code outside `[a-z0-9_]{1,32}` is replaced
/// by `bad_frame` so the frame is always well formed.
pub fn plain_error(code: &str) -> Vec<u8> {
    debug_assert!(is_valid_code(code), "invalid PLAIN_ERROR code {code:?}");
    let code = if is_valid_code(code) {
        code
    } else {
        codes::BAD_FRAME
    };
    let mut out = Vec::with_capacity(1 + code.len());
    out.push(OUT_PLAIN_ERROR);
    out.extend_from_slice(code.as_bytes());
    out
}

/// The code of a PLAIN_ERROR frame, if `frame` is one.
pub fn parse_plain_error(frame: &[u8]) -> Option<&str> {
    let (&first, code) = frame.split_first()?;
    if first != OUT_PLAIN_ERROR {
        return None;
    }
    let code = std::str::from_utf8(code).ok()?;
    is_valid_code(code).then_some(code)
}

// ---------------------------------------------------------------------------
// Handshakes
// ---------------------------------------------------------------------------

/// A completed node-side handshake.
pub struct Established {
    /// The HS3 payload: the v1 `hello` JSON (validate with
    /// [`crate::protocol::parse_client_msg`]; its `device_id` and `relay` are
    /// authoritative). A payload that authenticated but is not UTF-8 is
    /// delivered as an empty string, so the parse fails and the caller answers
    /// with the encrypted `unauthorized` design §4.4 requires over `send`.
    pub hello: String,
    /// The device's static key; the caller compares it with the pinned key.
    pub remote_static: [u8; 32],
    /// The Noise handshake hash.
    pub handshake_hash: [u8; 32],
    pub send: SendHalf,
    pub recv: RecvHalf,
}

impl std::fmt::Debug for Established {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Established")
            .field("hello_len", &self.hello.len())
            .field("handshake_hash", &hex::encode(self.handshake_hash))
            .finish_non_exhaustive()
    }
}

/// The node (responder) side of the handshake. The device_id comes from the row
/// the upgrade Bearer resolved, never from the wire.
pub struct ServerHandshake {
    responder: Responder,
    hs2_sent: bool,
}

impl ServerHandshake {
    /// A responder bound to `device_id` through the prologue.
    pub fn new(identity: &NodeIdentity, device_id: &str) -> Result<Self, SecureError> {
        let prologue = prologue(device_id)?;
        Ok(Self {
            responder: Responder::from_secret(identity.static_secret(), &prologue),
            hs2_sent: false,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_ephemeral(
        node_static: &[u8; 32],
        node_ephemeral: &[u8; 32],
        device_id: &str,
    ) -> Result<Self, SecureError> {
        let prologue = prologue(device_id)?;
        Ok(Self {
            responder: Responder::with_ephemeral(node_static, node_ephemeral, &prologue),
            hs2_sent: false,
        })
    }

    /// Consume HS1 and produce HS2 (payload `01 00`).
    pub fn on_hs1(&mut self, frame: &[u8]) -> Result<Vec<u8>, SecureError> {
        if self.hs2_sent {
            return Err(SecureError::Protocol("HS1 after HS2"));
        }
        validate_hs1(frame).map_err(|error| match error {
            Hs1Error::BadFrame => SecureError::BadFrame,
            Hs1Error::UnsupportedVersion => SecureError::UnsupportedVersion,
        })?;
        let payload = self.responder.read_message(&frame[4..])?;
        if !payload.is_empty() {
            return Err(SecureError::BadFrame);
        }
        let msg2 = self.responder.write_message(&HS2_PAYLOAD)?;
        self.hs2_sent = true;
        let mut out = Vec::with_capacity(HS2_LEN);
        out.push(OUT_HS2);
        out.extend(msg2);
        Ok(out)
    }

    /// Consume HS3 and finish. The caller still checks `remote_static` against
    /// the pin and the hello's `device_id`/`relay` against the row.
    pub fn on_hs3(mut self, frame: &[u8], now: Instant) -> Result<Established, SecureError> {
        if !self.hs2_sent {
            return Err(SecureError::Protocol("HS3 before HS2"));
        }
        if frame.first() != Some(&OUT_HS3) || frame.len() < HS3_MIN_LEN {
            return Err(SecureError::BadFrame);
        }
        if frame.len() > HS3_MAX_LEN {
            return Err(SecureError::BadHello);
        }
        let payload = self.responder.read_message(&frame[1..])?;
        // The payload authenticated, so the session exists: a non-UTF-8 hello is
        // the caller's to refuse with an encrypted `unauthorized` (§4.4 step 8),
        // not a pre-session failure.
        let hello = String::from_utf8(payload).unwrap_or_default();
        let remote_static = self
            .responder
            .remote_static()
            .ok_or(SecureError::BadFrame)?;
        let handshake_hash = self
            .responder
            .handshake_hash()
            .ok_or(SecureError::BadFrame)?;
        let (send, recv) = self.responder.into_transport()?;
        Ok(Established {
            hello,
            remote_static,
            handshake_hash,
            send: SendHalf::new(send, now),
            recv: RecvHalf::new(recv, now),
        })
    }
}

/// The device (initiator) side of the handshake: used by Core's ingress tests and
/// the C interop test to play a device.
pub struct ClientHandshake {
    initiator: Initiator,
    pinned_node_pub: [u8; 32],
    hs1_sent: bool,
}

impl ClientHandshake {
    /// A device with static secret `device_secret` that pins `pinned_node_pub`.
    pub fn new(
        device_secret: [u8; 32],
        pinned_node_pub: [u8; 32],
        device_id: &str,
    ) -> Result<Self, SecureError> {
        let prologue = prologue(device_id)?;
        let device_secret = zeroize::Zeroizing::new(device_secret);
        Ok(Self {
            initiator: Initiator::new(&device_secret, &prologue),
            pinned_node_pub,
            hs1_sent: false,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_ephemeral(
        device_secret: [u8; 32],
        device_ephemeral: [u8; 32],
        pinned_node_pub: [u8; 32],
        device_id: &str,
    ) -> Result<Self, SecureError> {
        let prologue = prologue(device_id)?;
        Ok(Self {
            initiator: Initiator::with_ephemeral(&device_secret, &device_ephemeral, &prologue),
            pinned_node_pub,
            hs1_sent: false,
        })
    }

    /// HS1 (`01 01 01 00 e`).
    pub fn hs1(&mut self) -> Result<Vec<u8>, SecureError> {
        if self.hs1_sent {
            return Err(SecureError::Protocol("HS1 already sent"));
        }
        let msg1 = self.initiator.write_message(&[])?;
        self.hs1_sent = true;
        let mut out = Vec::with_capacity(HS1_LEN);
        out.extend_from_slice(&[OUT_HS1, RHN_VERSION, RHN_SUITE, RHN_FLAGS]);
        out.extend(msg1);
        Ok(out)
    }

    /// Consume HS2 and produce HS3 carrying `hello`. The pin is checked BEFORE HS3
    /// is produced, so a mismatch never reveals the device's static key.
    pub fn on_hs2(
        self,
        frame: &[u8],
        hello: &str,
        now: Instant,
    ) -> Result<(Vec<u8>, SendHalf, RecvHalf), SecureError> {
        self.on_hs2_bytes(frame, hello.as_bytes(), now)
    }

    /// [`Self::on_hs2`] over raw hello bytes (tests drive a non-UTF-8 hello).
    fn on_hs2_bytes(
        mut self,
        frame: &[u8],
        hello: &[u8],
        now: Instant,
    ) -> Result<(Vec<u8>, SendHalf, RecvHalf), SecureError> {
        if !self.hs1_sent {
            return Err(SecureError::Protocol("HS2 before HS1"));
        }
        if frame.first() != Some(&OUT_HS2) || frame.len() != HS2_LEN {
            return Err(SecureError::BadFrame);
        }
        if hello.len() > MAX_HELLO_LEN {
            return Err(SecureError::BadHello);
        }
        let payload = self.initiator.read_message(&frame[1..])?;
        let remote = self
            .initiator
            .remote_static()
            .ok_or(SecureError::BadFrame)?;
        if !bool::from(remote.ct_eq(&self.pinned_node_pub)) {
            return Err(SecureError::PinMismatch);
        }
        if payload.first().is_none_or(|minor| *minor < MIN_MINOR) {
            return Err(SecureError::UnsupportedVersion);
        }
        let msg3 = self.initiator.write_message(hello)?;
        let (send, recv) = self.initiator.into_transport()?;
        let mut out = Vec::with_capacity(1 + msg3.len());
        out.push(OUT_HS3);
        out.extend(msg3);
        Ok((out, SendHalf::new(send, now), RecvHalf::new(recv, now)))
    }
}

// ---------------------------------------------------------------------------
// Transport halves
// ---------------------------------------------------------------------------

/// What a [`SendHalf::seal`] carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboundKind {
    /// One RHP JSON message (fragmented if longer than one record).
    Control,
    /// One Opus packet (never fragmented).
    Audio,
    /// JPEG bytes (fragmented).
    Blob,
}

impl OutboundKind {
    fn inner_type(self) -> u8 {
        match self {
            OutboundKind::Control => INNER_CONTROL,
            OutboundKind::Audio => INNER_AUDIO,
            OutboundKind::Blob => INNER_BLOB,
        }
    }

    fn max_len(self) -> usize {
        match self {
            OutboundKind::Control => MAX_CONTROL_LEN,
            OutboundKind::Audio => MAX_BODY,
            OutboundKind::Blob => MAX_BLOB_LEN,
        }
    }
}

/// One decoded inbound logical message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Inbound {
    Control(String),
    Audio(Vec<u8>),
    Blob(Vec<u8>),
    Keepalive,
}

/// The sending direction of an established session. Owned, so it can live on the
/// send task while the [`RecvHalf`] lives on the receive task.
pub struct SendHalf {
    cs: CipherState,
    records_since_rekey: u64,
    last_rekey: Instant,
    poisoned: bool,
}

impl std::fmt::Debug for SendHalf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SendHalf")
            .field("nonce", &self.cs.nonce())
            .field("records_since_rekey", &self.records_since_rekey)
            .field("poisoned", &self.poisoned)
            .finish()
    }
}

fn record_plaintext(inner_type: u8, flags: u8, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::with_capacity(2 + body.len());
    inner.push(inner_type);
    inner.push(flags);
    inner.extend_from_slice(body);
    inner
}

impl SendHalf {
    fn new(cs: CipherState, now: Instant) -> Self {
        Self {
            cs,
            records_since_rekey: 0,
            last_rekey: now,
            poisoned: false,
        }
    }

    /// The next nonce (records sealed so far in this direction).
    pub fn nonce(&self) -> u64 {
        self.cs.nonce()
    }

    fn rekey_due(&self, now: Instant) -> bool {
        self.records_since_rekey >= REKEY_AFTER_RECORDS
            || now.saturating_duration_since(self.last_rekey) >= REKEY_AFTER
    }

    /// Refuse (without sealing anything) when `count` more records would reach
    /// the 2^32 nonce cap, so a sealed record is never discarded.
    fn reserve(&mut self, count: u64) -> Result<(), SecureError> {
        if self.poisoned {
            return Err(SecureError::Poisoned);
        }
        if self.cs.nonce().saturating_add(count) > MAX_RECORDS {
            self.poisoned = true;
            return Err(SecureError::NonceExhausted);
        }
        Ok(())
    }

    fn seal_record(
        &mut self,
        inner_type: u8,
        flags: u8,
        body: &[u8],
    ) -> Result<Vec<u8>, SecureError> {
        let inner = zeroize::Zeroizing::new(record_plaintext(inner_type, flags, body));
        match self.cs.encrypt_with_ad(&[], &inner) {
            Ok(ciphertext) => {
                let mut frame = Vec::with_capacity(1 + ciphertext.len());
                frame.push(OUT_DATA);
                frame.extend(ciphertext);
                Ok(frame)
            }
            Err(error) => {
                self.poisoned = true;
                Err(error.into())
            }
        }
    }

    fn seal_rekey(&mut self, now: Instant) -> Result<Vec<u8>, SecureError> {
        let frame = self.seal_record(INNER_REKEY, 0, &[])?;
        if let Err(error) = self.cs.rekey() {
            self.poisoned = true;
            return Err(error.into());
        }
        self.records_since_rekey = 0;
        self.last_rekey = now;
        Ok(frame)
    }

    /// Seal one logical message into DATA frames: a boundary REKEY first when due
    /// (65535 records or 600 s), then the fragments (MORE on all but the last).
    pub fn seal(
        &mut self,
        kind: OutboundKind,
        body: &[u8],
        now: Instant,
    ) -> Result<Vec<Vec<u8>>, SecureError> {
        if self.poisoned {
            return Err(SecureError::Poisoned);
        }
        if body.len() > kind.max_len() {
            return Err(SecureError::Limit(match kind {
                OutboundKind::Control => "control message exceeds 65536 bytes",
                OutboundKind::Audio => "audio packet exceeds one record",
                OutboundKind::Blob => "blob exceeds 262144 bytes",
            }));
        }
        let fragments: Vec<&[u8]> = if body.is_empty() {
            vec![&[][..]]
        } else {
            body.chunks(MAX_BODY).collect()
        };
        let rekey = self.rekey_due(now);
        self.reserve(fragments.len() as u64 + u64::from(rekey))?;
        let mut frames = Vec::with_capacity(fragments.len() + usize::from(rekey));
        if rekey {
            frames.push(self.seal_rekey(now)?);
        }
        let last = fragments.len() - 1;
        for (index, fragment) in fragments.into_iter().enumerate() {
            let flags = if index < last { FLAG_MORE } else { 0 };
            frames.push(self.seal_record(kind.inner_type(), flags, fragment)?);
            self.records_since_rekey += 1;
        }
        Ok(frames)
    }

    /// Seal a REKEY record now and rotate the send key.
    pub fn rekey_now(&mut self, now: Instant) -> Result<Vec<u8>, SecureError> {
        self.reserve(1)?;
        self.seal_rekey(now)
    }

    /// Seal a KEEPALIVE (preceded by a boundary REKEY when one is due, so an idle
    /// but live session still rekeys on time).
    pub fn keepalive(&mut self, now: Instant) -> Result<Vec<Vec<u8>>, SecureError> {
        if self.poisoned {
            return Err(SecureError::Poisoned);
        }
        let rekey = self.rekey_due(now);
        self.reserve(1 + u64::from(rekey))?;
        let mut frames = Vec::with_capacity(2);
        if rekey {
            frames.push(self.seal_rekey(now)?);
        }
        frames.push(self.seal_record(INNER_KEEPALIVE, 0, &[])?);
        self.records_since_rekey += 1;
        Ok(frames)
    }

    #[cfg(test)]
    pub(crate) fn set_nonce_for_tests(&mut self, n: u64) {
        self.cs.set_nonce_for_tests(n);
    }

    #[cfg(test)]
    pub(crate) fn set_records_since_rekey_for_tests(&mut self, n: u64) {
        self.records_since_rekey = n;
    }
}

/// The receiving direction of an established session.
pub struct RecvHalf {
    cs: CipherState,
    records_since_rekey: u64,
    last_rekey: Instant,
    assembling: Option<(u8, Vec<u8>)>,
    poisoned: bool,
}

impl std::fmt::Debug for RecvHalf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecvHalf")
            .field("nonce", &self.cs.nonce())
            .field("records_since_rekey", &self.records_since_rekey)
            .field(
                "assembling",
                &self.assembling.as_ref().map(|(t, b)| (*t, b.len())),
            )
            .field("poisoned", &self.poisoned)
            .finish()
    }
}

impl RecvHalf {
    fn new(cs: CipherState, now: Instant) -> Self {
        Self {
            cs,
            records_since_rekey: 0,
            last_rekey: now,
            assembling: None,
            poisoned: false,
        }
    }

    /// The next nonce expected from the peer.
    pub fn nonce(&self) -> u64 {
        self.cs.nonce()
    }

    /// Open one DATA frame. Returns `Some` when a logical message completes, `None`
    /// for a REKEY or a non-final fragment. Any error poisons this half.
    pub fn open(&mut self, frame: &[u8], now: Instant) -> Result<Option<Inbound>, SecureError> {
        if self.poisoned {
            return Err(SecureError::Poisoned);
        }
        let result = self.open_inner(frame, now);
        if result.is_err() {
            self.poisoned = true;
            self.cs.poison();
            self.assembling = None;
        }
        result
    }

    fn open_inner(&mut self, frame: &[u8], now: Instant) -> Result<Option<Inbound>, SecureError> {
        if frame.first() != Some(&OUT_DATA) {
            return Err(SecureError::Protocol("expected a DATA frame"));
        }
        if frame.len() < MIN_DATA_FRAME {
            return Err(SecureError::BadFrame);
        }
        if frame.len() > MAX_DATA_FRAME {
            return Err(SecureError::Limit("DATA frame exceeds 16401 bytes"));
        }
        if self.cs.nonce() >= MAX_RECORDS {
            return Err(SecureError::NonceExhausted);
        }
        let inner = self.cs.decrypt_with_ad(&[], &frame[1..])?;
        let (inner_type, flags, body) = (inner[0], inner[1], &inner[2..]);
        if flags & !FLAG_MORE != 0 {
            return Err(SecureError::Protocol("reserved flag bits set"));
        }
        let more = flags & FLAG_MORE != 0;
        let mid_message = self.assembling.is_some();

        if inner_type == INNER_REKEY {
            if more || !body.is_empty() {
                return Err(SecureError::Protocol("REKEY must be a single empty record"));
            }
            if mid_message {
                return Err(SecureError::Protocol("REKEY inside a fragmented message"));
            }
            self.cs.rekey()?;
            self.records_since_rekey = 0;
            self.last_rekey = now;
            return Ok(None);
        }

        self.records_since_rekey += 1;
        if self.records_since_rekey > REKEY_OVERDUE_RECORDS
            || now.saturating_duration_since(self.last_rekey) > REKEY_OVERDUE
        {
            return Err(SecureError::RekeyOverdue);
        }

        match inner_type {
            INNER_KEEPALIVE | INNER_AUDIO => {
                if more {
                    return Err(SecureError::Protocol("MORE on a single-record type"));
                }
                if mid_message {
                    return Err(SecureError::Protocol("record inside a fragmented message"));
                }
                if inner_type == INNER_KEEPALIVE {
                    if !body.is_empty() {
                        return Err(SecureError::Protocol("KEEPALIVE must be empty"));
                    }
                    Ok(Some(Inbound::Keepalive))
                } else {
                    Ok(Some(Inbound::Audio(body.to_vec())))
                }
            }
            INNER_CONTROL | INNER_BLOB => {
                let cap = if inner_type == INNER_CONTROL {
                    MAX_CONTROL_LEN
                } else {
                    MAX_BLOB_LEN
                };
                let mut buffer = match self.assembling.take() {
                    Some((kind, _)) if kind != inner_type => {
                        return Err(SecureError::Protocol("type changed mid-message"));
                    }
                    Some((_, buffer)) => buffer,
                    None => Vec::new(),
                };
                if buffer.len() + body.len() > cap {
                    return Err(SecureError::Limit(if inner_type == INNER_CONTROL {
                        "control message exceeds 65536 bytes"
                    } else {
                        "blob exceeds 262144 bytes"
                    }));
                }
                buffer.extend_from_slice(body);
                if more {
                    self.assembling = Some((inner_type, buffer));
                    return Ok(None);
                }
                if inner_type == INNER_CONTROL {
                    let text = String::from_utf8(buffer)
                        .map_err(|_| SecureError::Protocol("CONTROL is not UTF-8"))?;
                    Ok(Some(Inbound::Control(text)))
                } else {
                    Ok(Some(Inbound::Blob(buffer)))
                }
            }
            _ => Err(SecureError::Protocol("unknown inner type")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const NOISE: &str = include_str!("../tests/vectors/rhp_v1_1_noise.json");

    fn vectors() -> Value {
        serde_json::from_str(NOISE).unwrap()
    }

    fn hex32(value: &Value) -> [u8; 32] {
        hex::decode(value.as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap()
    }

    fn bytes(value: &Value) -> Vec<u8> {
        hex::decode(value.as_str().unwrap()).unwrap()
    }

    fn sha256_hex(data: &[u8]) -> String {
        hex::encode(noise::sha256(&[data]))
    }

    /// Run the vector handshake with fixed ephemerals; returns
    /// (device send, device recv, established node side).
    fn vector_session(now: Instant) -> (SendHalf, RecvHalf, Established) {
        let v = vectors();
        let keys = &v["keys"];
        let device_id = v["device_id"].as_str().unwrap();
        let mut client = ClientHandshake::with_ephemeral(
            hex32(&keys["device_static_sk"]),
            hex32(&keys["device_ephemeral_sk"]),
            hex32(&keys["node_static_pub"]),
            device_id,
        )
        .unwrap();
        let mut server = ServerHandshake::with_ephemeral(
            &hex32(&keys["node_static_sk"]),
            &hex32(&keys["node_ephemeral_sk"]),
            device_id,
        )
        .unwrap();
        assert_eq!(prologue(device_id).unwrap(), bytes(&v["prologue_hex"]));
        let hs1 = client.hs1().unwrap();
        assert_eq!(hs1, bytes(&v["hs1_hex"]));
        assert_eq!(validate_hs1(&hs1), Ok(()));
        let hs2 = server.on_hs1(&hs1).unwrap();
        assert_eq!(hs2, bytes(&v["hs2_hex"]));
        assert_eq!(hs2.len(), HS2_LEN);
        let hello = v["hs3_payload_utf8"].as_str().unwrap();
        let (hs3, d_send, d_recv) = client.on_hs2(&hs2, hello, now).unwrap();
        assert_eq!(hs3, bytes(&v["hs3_hex"]));
        let established = server.on_hs3(&hs3, now).unwrap();
        assert_eq!(established.hello, hello);
        assert_eq!(established.remote_static, hex32(&keys["device_static_pub"]));
        assert_eq!(established.handshake_hash, hex32(&v["handshake_hash_hex"]));
        (d_send, d_recv, established)
    }

    fn inner_body(record: &Value) -> Vec<u8> {
        bytes(&record["inner_hex"])[2..].to_vec()
    }

    #[test]
    fn every_vector_record_is_reproduced_and_opened() {
        let now = Instant::now();
        let v = vectors();
        let (mut d_send, mut d_recv, established) = vector_session(now);
        let Established {
            send: mut n_send,
            recv: mut n_recv,
            ..
        } = established;
        let blob: Vec<u8> = (0..20_000u32).map(|i| (i % 251) as u8).collect();
        let mut blob_frames = Vec::new();

        for record in v["records"].as_array().unwrap() {
            let label = record["label"].as_str().unwrap();
            let d2n = record["dir"] == "d2n";
            let (sender, receiver) = if d2n {
                (&mut d_send, &mut n_recv)
            } else {
                (&mut n_send, &mut d_recv)
            };
            // Both blob fragments are sealed by one call, before fragment 0 is checked.
            if label != "blob_fragment_1" {
                assert_eq!(sender.nonce(), record["nonce"].as_u64().unwrap(), "{label}");
            }
            let frames: Vec<Vec<u8>> = match label {
                "rekey" => vec![sender.rekey_now(now).unwrap()],
                "keepalive_after_rekey" => sender.keepalive(now).unwrap(),
                "blob_fragment_0" => {
                    blob_frames = sender.seal(OutboundKind::Blob, &blob, now).unwrap();
                    assert_eq!(blob_frames.len(), 2);
                    vec![blob_frames[0].clone()]
                }
                "blob_fragment_1" => vec![blob_frames[1].clone()],
                _ => {
                    let kind = match record["inner_type"].as_u64().unwrap() {
                        1 => OutboundKind::Control,
                        2 => OutboundKind::Audio,
                        other => panic!("unexpected inner type {other}"),
                    };
                    sender.seal(kind, &inner_body(record), now).unwrap()
                }
            };
            assert_eq!(frames.len(), 1, "{label}");
            let frame = &frames[0];
            assert_eq!(
                frame.len() as u64,
                record["frame_len"].as_u64().unwrap(),
                "{label}"
            );
            assert_eq!(
                sha256_hex(frame),
                record["frame_sha256"].as_str().unwrap(),
                "{label}"
            );
            if let Some(full) = record.get("frame_hex") {
                assert_eq!(*frame, bytes(full), "{label}");
            }

            let opened = receiver.open(frame, now).unwrap();
            match label {
                "rekey" => assert_eq!(opened, None),
                "keepalive_after_rekey" => assert_eq!(opened, Some(Inbound::Keepalive)),
                "blob_fragment_0" => assert_eq!(opened, None),
                "blob_fragment_1" => assert_eq!(opened, Some(Inbound::Blob(blob.clone()))),
                _ if record["inner_type"] == 2 => {
                    assert_eq!(opened, Some(Inbound::Audio(inner_body(record))));
                }
                _ => assert_eq!(
                    opened,
                    Some(Inbound::Control(
                        String::from_utf8(inner_body(record)).unwrap()
                    ))
                ),
            }
        }
    }

    #[test]
    fn hs1_and_plain_error_rules() {
        let mut hs1 = vec![OUT_HS1, 1, 1, 0];
        hs1.extend([7u8; 32]);
        assert_eq!(validate_hs1(&hs1), Ok(()));
        assert_eq!(validate_hs1(&hs1[..35]), Err(Hs1Error::BadFrame));
        assert_eq!(validate_hs1(&[]), Err(Hs1Error::BadFrame));
        assert_eq!(validate_hs1(&[0x7B, 1, 1, 0]), Err(Hs1Error::BadFrame));
        let mut v2 = hs1.clone();
        v2[1] = 2;
        assert_eq!(validate_hs1(&v2), Err(Hs1Error::UnsupportedVersion));
        let mut flags = hs1.clone();
        flags[3] = 1;
        assert_eq!(
            validate_hs1(&flags).unwrap_err().code(),
            "unsupported_version"
        );

        let frame = plain_error("repair_required");
        assert_eq!(frame[0], 0x7F);
        assert_eq!(parse_plain_error(&frame), Some("repair_required"));
        assert_eq!(parse_plain_error(&[0x7F]), None);
        assert_eq!(parse_plain_error(b"\x7FBad"), None);
        assert!(plain_error(&"a".repeat(32)).len() == 33);

        assert!(prologue("rhw_0123456789abcdef").is_ok());
        assert_eq!(prologue(""), Err(SecureError::InvalidDeviceId));
        assert_eq!(prologue(&"a".repeat(64)), Err(SecureError::InvalidDeviceId));
        assert_eq!(prologue("bad id"), Err(SecureError::InvalidDeviceId));
        assert!(prologue(&"A-z_9".repeat(12)).is_ok());
    }

    fn established_pair(now: Instant) -> (SendHalf, RecvHalf, SendHalf, RecvHalf) {
        let node = NodeIdentity::generate();
        let device_sk = [0x42u8; 32];
        let mut client = ClientHandshake::new(device_sk, node.public(), "rhw_test").unwrap();
        let mut server = ServerHandshake::new(&node, "rhw_test").unwrap();
        let hs2 = server.on_hs1(&client.hs1().unwrap()).unwrap();
        let (hs3, d_send, d_recv) = client.on_hs2(&hs2, "{}", now).unwrap();
        let est = server.on_hs3(&hs3, now).unwrap();
        assert_eq!(
            est.remote_static,
            crate::pair_crypto::public_key(&device_sk)
        );
        (d_send, d_recv, est.send, est.recv)
    }

    #[test]
    fn control_fragmentation_limits() {
        let now = Instant::now();
        let (mut d_send, _, _, mut n_recv) = established_pair(now);
        let big = "x".repeat(MAX_CONTROL_LEN);
        let frames = d_send
            .seal(OutboundKind::Control, big.as_bytes(), now)
            .unwrap();
        assert_eq!(frames.len(), MAX_CONTROL_LEN.div_ceil(MAX_BODY));
        assert!(frames.iter().all(|f| f.len() <= MAX_DATA_FRAME));
        let mut out = None;
        for frame in &frames {
            out = n_recv.open(frame, now).unwrap();
        }
        assert_eq!(out, Some(Inbound::Control(big)));

        // The sender refuses 70000 bytes outright...
        let huge = vec![b'y'; 70_000];
        assert!(matches!(
            d_send.seal(OutboundKind::Control, &huge, now),
            Err(SecureError::Limit(_))
        ));
        assert!(matches!(
            d_send.seal(OutboundKind::Audio, &huge[..MAX_BODY + 1], now),
            Err(SecureError::Limit(_))
        ));
        // ...and a receiver fails a peer that fragments past the cap anyway.
        let (mut d_send, _, _, mut n_recv) = established_pair(now);
        let mut failed = None;
        for chunk in huge.chunks(MAX_BODY) {
            let frame = d_send.seal_record(INNER_CONTROL, FLAG_MORE, chunk).unwrap();
            if let Err(error) = n_recv.open(&frame, now) {
                failed = Some(error);
                break;
            }
        }
        assert!(matches!(failed, Some(SecureError::Limit(_))));
        assert_eq!(
            n_recv.open(&[OUT_DATA; 20], now),
            Err(SecureError::Poisoned)
        );
    }

    #[test]
    fn framing_violations_are_fatal() {
        let now = Instant::now();
        type Records = Vec<(u8, u8, Vec<u8>)>;
        let cases: [(&str, Records); 9] = [
            ("reserved bits", vec![(INNER_CONTROL, 0x02, b"{}".to_vec())]),
            ("unknown type", vec![(9, 0, vec![])]),
            ("more on audio", vec![(INNER_AUDIO, FLAG_MORE, vec![1])]),
            (
                "more on keepalive",
                vec![(INNER_KEEPALIVE, FLAG_MORE, vec![])],
            ),
            ("non-empty keepalive", vec![(INNER_KEEPALIVE, 0, vec![1])]),
            ("non-empty rekey", vec![(INNER_REKEY, 0, vec![1])]),
            (
                "type change mid-message",
                vec![
                    (INNER_CONTROL, FLAG_MORE, b"{".to_vec()),
                    (INNER_BLOB, 0, vec![1]),
                ],
            ),
            (
                "keepalive mid-message",
                vec![
                    (INNER_CONTROL, FLAG_MORE, b"{".to_vec()),
                    (INNER_KEEPALIVE, 0, vec![]),
                ],
            ),
            (
                "rekey mid-message",
                vec![(INNER_BLOB, FLAG_MORE, vec![1]), (INNER_REKEY, 0, vec![])],
            ),
        ];
        for (name, records) in cases {
            let (mut d_send, _, _, mut n_recv) = established_pair(now);
            let mut result = Ok(None);
            for (inner_type, flags, body) in records {
                let frame = d_send.seal_record(inner_type, flags, &body).unwrap();
                result = n_recv.open(&frame, now);
                if result.is_err() {
                    break;
                }
            }
            assert!(
                matches!(result, Err(SecureError::Protocol(_))),
                "{name}: {result:?}"
            );
            assert_eq!(result.unwrap_err().code(), "bad_frame");
        }

        // Wrong outer type, short frames, oversize frames, tampering.
        let (mut d_send, _, _, mut n_recv) = established_pair(now);
        let mut frame = d_send
            .seal(OutboundKind::Audio, &[1, 2], now)
            .unwrap()
            .remove(0);
        frame[5] ^= 0x80;
        assert_eq!(n_recv.open(&frame, now), Err(SecureError::Decrypt));
        let (_, _, _, mut n_recv) = established_pair(now);
        assert_eq!(n_recv.open(&[OUT_DATA; 5], now), Err(SecureError::BadFrame));
        let (_, _, _, mut n_recv) = established_pair(now);
        assert!(matches!(
            n_recv.open(&[OUT_HS3; 40], now),
            Err(SecureError::Protocol(_))
        ));
        let (_, _, _, mut n_recv) = established_pair(now);
        assert!(matches!(
            n_recv.open(&vec![OUT_DATA; MAX_DATA_FRAME + 1], now),
            Err(SecureError::Limit(_))
        ));
        // Replay of an already-opened record fails.
        let (mut d_send, _, _, mut n_recv) = established_pair(now);
        let frame = d_send
            .seal(OutboundKind::Audio, &[1], now)
            .unwrap()
            .remove(0);
        n_recv.open(&frame, now).unwrap();
        assert_eq!(n_recv.open(&frame, now), Err(SecureError::Decrypt));
    }

    #[test]
    fn rekey_at_boundaries_and_overdue() {
        let t0 = Instant::now();
        let (mut d_send, _, _, mut n_recv) = established_pair(t0);
        // Time-based rekey at the next boundary.
        let later = t0 + REKEY_AFTER;
        let frames = d_send.seal(OutboundKind::Control, b"{}", later).unwrap();
        assert_eq!(frames.len(), 2, "REKEY precedes the message");
        assert_eq!(n_recv.open(&frames[0], later).unwrap(), None);
        assert_eq!(
            n_recv.open(&frames[1], later).unwrap(),
            Some(Inbound::Control("{}".into()))
        );
        // Count-based rekey.
        d_send.set_records_since_rekey_for_tests(REKEY_AFTER_RECORDS);
        let frames = d_send.keepalive(later).unwrap();
        assert_eq!(frames.len(), 2);
        for frame in &frames {
            n_recv.open(frame, later).unwrap();
        }
        // A peer that never rekeys is overdue after 1200 s.
        let (mut d_send, _, _, mut n_recv) = established_pair(t0);
        let frame = d_send.seal_record(INNER_KEEPALIVE, 0, &[]).unwrap();
        let overdue = t0 + REKEY_OVERDUE + Duration::from_secs(1);
        assert_eq!(n_recv.open(&frame, overdue), Err(SecureError::RekeyOverdue));
        assert_eq!(SecureError::RekeyOverdue.code(), "rekey_overdue");
        // ...or after 131072 records.
        let (mut d_send, _, _, mut n_recv) = established_pair(t0);
        n_recv.records_since_rekey = REKEY_OVERDUE_RECORDS;
        let frame = d_send.seal_record(INNER_AUDIO, 0, &[1]).unwrap();
        assert_eq!(n_recv.open(&frame, t0), Err(SecureError::RekeyOverdue));
    }

    #[test]
    fn nonce_cap_refuses_without_sealing() {
        let now = Instant::now();
        let (mut d_send, _, _, _) = established_pair(now);
        d_send.set_nonce_for_tests(MAX_RECORDS - 1);
        // Two fragments would cross 2^32: nothing is sealed.
        let body = vec![0u8; MAX_BODY + 1];
        assert_eq!(
            d_send.seal(OutboundKind::Blob, &body, now),
            Err(SecureError::NonceExhausted)
        );
        assert_eq!(d_send.nonce(), MAX_RECORDS - 1);
        assert_eq!(
            d_send.seal(OutboundKind::Audio, &[1], now),
            Err(SecureError::Poisoned)
        );
        let (mut d_send, _, _, _) = established_pair(now);
        d_send.set_nonce_for_tests(MAX_RECORDS - 1);
        assert_eq!(
            d_send.seal(OutboundKind::Audio, &[1], now).unwrap().len(),
            1
        );
        assert_eq!(d_send.rekey_now(now), Err(SecureError::NonceExhausted));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn halves_work_on_two_tasks() {
        let now = Instant::now();
        let (mut d_send, mut d_recv, mut n_send, mut n_recv) = established_pair(now);
        let (to_node, mut node_inbox) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
        let (to_device, mut device_inbox) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

        let device_sender = tokio::spawn(async move {
            for i in 0..50u8 {
                for frame in d_send
                    .seal(OutboundKind::Audio, &[i], Instant::now())
                    .unwrap()
                {
                    to_node.send(frame).await.unwrap();
                }
            }
        });
        let node_echo = tokio::spawn(async move {
            let mut received = 0;
            while let Some(frame) = node_inbox.recv().await {
                if let Some(Inbound::Audio(body)) = n_recv.open(&frame, Instant::now()).unwrap() {
                    for out in n_send
                        .seal(OutboundKind::Audio, &body, Instant::now())
                        .unwrap()
                    {
                        to_device.send(out).await.unwrap();
                    }
                    received += 1;
                }
            }
            received
        });
        let device_receiver = tokio::spawn(async move {
            let mut echoed = Vec::new();
            while let Some(frame) = device_inbox.recv().await {
                if let Some(Inbound::Audio(body)) = d_recv.open(&frame, Instant::now()).unwrap() {
                    echoed.push(body[0]);
                }
            }
            echoed
        });
        device_sender.await.unwrap();
        assert_eq!(node_echo.await.unwrap(), 50);
        assert_eq!(device_receiver.await.unwrap(), (0..50).collect::<Vec<u8>>());
    }

    #[test]
    fn full_client_server_session() {
        let now = Instant::now();
        let node = NodeIdentity::generate();
        let device_sk = [0x11u8; 32];
        let device_id = "rhn_abcdef";
        let mut client = ClientHandshake::new(device_sk, node.public(), device_id).unwrap();
        let mut server = ServerHandshake::new(&node, device_id).unwrap();
        let hello = r#"{"type":"hello","device_id":"rhn_abcdef","device_type":"necklace","fw_version":"1","relay":true,"audio":{"codec":"opus","sample_rate":16000,"frame_ms":60},"caps":{"display":false,"camera":false,"speaker":true,"mic":true}}"#;
        let hs2 = server.on_hs1(&client.hs1().unwrap()).unwrap();
        let (hs3, mut d_send, mut d_recv) = client.on_hs2(&hs2, hello, now).unwrap();
        let mut est = server.on_hs3(&hs3, now).unwrap();
        assert!(matches!(
            crate::protocol::parse_client_msg(&est.hello).unwrap(),
            crate::protocol::RhpClientMsg::Hello { relay: true, .. }
        ));
        let ack = br#"{"type":"hello_ack"}"#;
        for frame in est.send.seal(OutboundKind::Control, ack, now).unwrap() {
            assert_eq!(
                d_recv.open(&frame, now).unwrap(),
                Some(Inbound::Control(String::from_utf8(ack.to_vec()).unwrap()))
            );
        }
        let rekey = d_send.rekey_now(now).unwrap();
        assert_eq!(est.recv.open(&rekey, now).unwrap(), None);
        for frame in d_send.seal(OutboundKind::Audio, &[9, 9], now).unwrap() {
            assert_eq!(
                est.recv.open(&frame, now).unwrap(),
                Some(Inbound::Audio(vec![9, 9]))
            );
        }
    }

    #[test]
    fn wrong_device_id_or_pin_fails() {
        let now = Instant::now();
        let node = NodeIdentity::generate();
        // The device binds a different device_id: HS2 fails to decrypt on the device.
        let mut client = ClientHandshake::new([3u8; 32], node.public(), "rhw_a").unwrap();
        let mut server = ServerHandshake::new(&node, "rhw_b").unwrap();
        let hs2 = server.on_hs1(&client.hs1().unwrap()).unwrap();
        assert_eq!(
            client.on_hs2(&hs2, "{}", now).unwrap_err(),
            SecureError::Decrypt
        );

        // A different node key: the device stops before HS3.
        let impostor = NodeIdentity::generate();
        let mut client = ClientHandshake::new([3u8; 32], node.public(), "rhw_a").unwrap();
        let mut server = ServerHandshake::new(&impostor, "rhw_a").unwrap();
        let hs2 = server.on_hs1(&client.hs1().unwrap()).unwrap();
        let err = client.on_hs2(&hs2, "{}", now).unwrap_err();
        assert_eq!(err, SecureError::PinMismatch);
        assert_eq!(err.code(), "unauthorized");

        // Bad HS frames on the server.
        let mut server = ServerHandshake::new(&node, "rhw_a").unwrap();
        assert_eq!(
            server.on_hs1(&[OUT_HS1, 2, 1, 0]),
            Err(SecureError::UnsupportedVersion)
        );
        let server = ServerHandshake::new(&node, "rhw_a").unwrap();
        assert!(matches!(
            server.on_hs3(&[OUT_HS3; 100], now),
            Err(SecureError::Protocol(_))
        ));
        let mut client = ClientHandshake::new([3u8; 32], node.public(), "rhw_a").unwrap();
        let mut server = ServerHandshake::new(&node, "rhw_a").unwrap();
        let hs2 = server.on_hs1(&client.hs1().unwrap()).unwrap();
        let (mut hs3, _, _) = client.on_hs2(&hs2, "{}", now).unwrap();
        hs3[10] ^= 1;
        assert_eq!(server.on_hs3(&hs3, now).unwrap_err(), SecureError::Decrypt);
        assert_eq!(SecureError::Decrypt.code(), "handshake_failed");
        // An over-long hello is refused before anything is sent.
        let mut client = ClientHandshake::new([3u8; 32], node.public(), "rhw_a").unwrap();
        let mut server = ServerHandshake::new(&node, "rhw_a").unwrap();
        let hs2 = server.on_hs1(&client.hs1().unwrap()).unwrap();
        assert_eq!(
            client
                .on_hs2(&hs2, &"x".repeat(MAX_HELLO_LEN + 1), now)
                .unwrap_err(),
            SecureError::BadHello
        );
    }

    #[test]
    fn non_utf8_hello_still_establishes_the_session() {
        let node = NodeIdentity::generate();
        let now = Instant::now();
        let mut client = ClientHandshake::new([3u8; 32], node.public(), "rhw_a").unwrap();
        let mut server = ServerHandshake::new(&node, "rhw_a").unwrap();
        let hs2 = server.on_hs1(&client.hs1().unwrap()).unwrap();
        // Build a valid HS3 whose plaintext is not UTF-8 by driving the
        // initiator directly.
        let (hs3, _, _) = client.on_hs2_bytes(&hs2, &[0xff, 0xfe], now).unwrap();
        let established = server.on_hs3(&hs3, now).unwrap();
        assert!(established.hello.is_empty());
        assert!(crate::protocol::parse_client_msg(&established.hello).is_err());
        // Every handshake-time error maps to a PLAIN_ERROR code.
        assert_eq!(SecureError::BadHello.code(), codes::HANDSHAKE_FAILED);
    }

    #[test]
    fn constants_match_the_spec() {
        assert_eq!(HS1_LEN, 36);
        assert_eq!(HS2_LEN, 99);
        assert_eq!(MAX_DATA_FRAME, 16_401);
        assert_eq!(HS3_MAX_LEN, 1 + 48 + 2048 + 16);
    }
}
