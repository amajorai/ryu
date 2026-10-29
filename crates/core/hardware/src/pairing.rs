//! Pairing: legacy v1 nonce pairing and the v1.1 two-phase, press-to-confirm,
//! key-bound pairing v2 (PROTOCOL.md §5, RHP v1.1 design §5).
//!
//! Every route these flows back is served by Core's `server::hardware_public` on
//! the **PROTECTED** router: the caller must present the node's `RYU_TOKEN`. This
//! crate holds the logic and the storage; Core owns the HTTP status mapping (see
//! [`PairError::http_status_hint`]), node-URL resolution, and the audit lines.
//!
//! ## Legacy v1 (`POST /api/hardware/pair`)
//!
//! An unprovisioned v1 device advertises `ryu-pair://<device_id>?n=<nonce>&t=<type>`
//! (QR for watch/desk, BLE characteristic for necklace). The app presents
//! `{ device_id, pairing_nonce, device_type }`; [`pair`] registers the device and
//! returns a per-device `device_token` + `node_url`. A device_id that is already
//! paired is rejected (re-pair requires an explicit revoke first), and the
//! `(device_id, nonce)` pair is burned in the SQLite `consumed_pair_nonces` ledger,
//! so a captured QR cannot be replayed, even across a node restart.
//!
//! ## Pairing v2 (`/api/hardware/pair/{begin,reveal,confirm,cancel}`)
//!
//! 1. [`begin_pair`]: the app relays the device's static key and its commitment to
//!    a fresh `device_rand`. The node persists a pending pairing (TTL 180 s, at most
//!    4 per node, one per device_id) and contributes a fresh `pairing_id` AFTER the
//!    commitment is fixed.
//! 2. [`reveal_pair`]: the app relays `device_rand`; the node checks the commitment
//!    (a mismatch deletes the pending pairing), then computes the transcript and the
//!    6-digit SAS the user compares with the device.
//! 3. [`confirm_pair`]: the app relays the device's `confirm_tag`, which only a
//!    device that holds `device_sk`, saw the same transcript, and was PRESSED can
//!    produce. The node recomputes it from `DH(node_sk, device_pub)` in constant
//!    time (a mismatch deletes the pending pairing), then in ONE transaction inserts
//!    the level-2 row, consumes the nonce and deletes the pending row, so confirm
//!    is single use. Only then does it mint `rht_`/`rhr_` tokens and seal
//!    `{device_token, node_url, wifi?}` to the device. The phone gets only the
//!    WS-only relay token and ciphertext.
//! 4. [`cancel_pair`]: idempotent removal of the pending pairing.

use crate::pair_crypto::{self, SealedCredentials, TranscriptInputs, RANDOM_LEN};
use crate::protocol::{
    device_type_str, parse_device_type, PairBeginRequest, PairBeginResponse, PairCancelRequest,
    PairConfirmRequest, PairConfirmResponse, PairRequest, PairResponse, PairRevealRequest,
    PairRevealResponse, WifiCredentials,
};
use crate::store::{
    hash_token, DeviceRecord, DeviceStore, PairedInsert, PendingInsert, PendingPairing,
    PendingState, PENDING_PAIRING_TTL_MS, PROTOCOL_LEVEL_SECURE,
};

/// Why a pairing attempt was rejected (maps to an `error.code` / HTTP status).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairError {
    /// Legacy: the nonce was missing/malformed (too short to be a real pairing
    /// nonce) or has already been consumed (replay).
    BadNonce,
    /// The device_id (or its static key) is already paired to this node.
    AlreadyPaired,
    /// Internal storage failure.
    Storage,
    /// No live pending pairing has this id (expired, cancelled, already
    /// confirmed, or never begun). A confirm replay lands here.
    UnknownOrExpired,
    /// `device_rand` does not open the device's commitment.
    CommitmentMismatch,
    /// The presented `confirm_tag` does not verify.
    ConfirmationMismatch,
    /// The device static key gives an all-zero DH with the node key.
    BadDeviceKey,
    /// A request field failed validation; the payload names the field.
    BadRequest(&'static str),
    /// The node already holds the maximum number of pending pairings.
    TooManyPending,
    /// The pending pairing is not in the state this step requires.
    BadState,
    /// The node identity is missing or cannot be opened.
    IdentityUnavailable,
    /// The resolved node URL does not fit the device's credential slot.
    NodeUrlTooLong,
}

impl PairError {
    /// Stable machine code for the JSON `error.code` field / logs.
    pub fn code(self) -> &'static str {
        match self {
            PairError::BadNonce => "bad_nonce",
            PairError::AlreadyPaired => "already_paired",
            PairError::Storage => "storage",
            PairError::UnknownOrExpired => "unknown_or_expired",
            PairError::CommitmentMismatch => "commitment_mismatch",
            PairError::ConfirmationMismatch => "confirmation_mismatch",
            PairError::BadDeviceKey => "bad_device_key",
            PairError::BadRequest(_) => "bad_request",
            PairError::TooManyPending => "too_many_pending",
            PairError::BadState => "bad_state",
            PairError::IdentityUnavailable => "node_identity_unavailable",
            PairError::NodeUrlTooLong => "node_url_too_long",
        }
    }

    /// Human-readable message for the REST response. Never contains secrets.
    pub fn message(self) -> &'static str {
        match self {
            PairError::BadNonce => "pairing nonce missing, malformed, or already used",
            PairError::AlreadyPaired => "device already paired (revoke it first to re-pair)",
            PairError::Storage => "device registry storage error",
            PairError::UnknownOrExpired => "pairing not found or expired; start again",
            PairError::CommitmentMismatch => {
                "the device's random value does not match its commitment"
            }
            PairError::ConfirmationMismatch => {
                "the device confirmation does not verify; possible interference"
            }
            PairError::BadDeviceKey => "the device key is not a usable X25519 public key",
            PairError::BadRequest(reason) => reason,
            PairError::TooManyPending => "too many pairings in progress; try again shortly",
            PairError::BadState => "this pairing step is out of order",
            PairError::IdentityUnavailable => "the node identity is unavailable",
            PairError::NodeUrlTooLong => "the node URL is too long for the device",
        }
    }

    /// The HTTP status design §5.6 assigns to this error.
    pub fn http_status_hint(self) -> u16 {
        match self {
            PairError::BadRequest(_) => 400,
            PairError::BadNonce
            | PairError::CommitmentMismatch
            | PairError::ConfirmationMismatch => 401,
            PairError::UnknownOrExpired => 404,
            PairError::AlreadyPaired | PairError::BadState => 409,
            PairError::BadDeviceKey | PairError::NodeUrlTooLong => 422,
            PairError::TooManyPending => 429,
            PairError::Storage => 500,
            PairError::IdentityUnavailable => 503,
        }
    }
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for PairError {}

/// Minimum accepted legacy nonce length. The firmware `pairing` component emits a
/// 128-bit nonce as hex (32 chars); legacy pairing accepts anything plausibly
/// random to stay tolerant of encoding, while rejecting empty/trivial values.
const MIN_NONCE_LEN: usize = 8;

/// The longest node URL the device's credential slot holds (`node_url[160]`).
pub const MAX_NODE_URL_LEN: usize = 159;

/// `expires_in` of `/pair/begin`, in seconds.
pub const PENDING_EXPIRES_IN_SECS: u32 = (PENDING_PAIRING_TTL_MS / 1000) as u32;

/// Generate a fresh, cryptographically-random per-device Bearer token (256 bits,
/// hex-encoded). The raw token is returned exactly once; only its hash is
/// persisted (see [`DeviceStore`]).
pub fn generate_device_token() -> String {
    format!("rht_{}", random_hex32())
}

/// Generate a fresh WS-only relay token for the phone (`rhr_` + 64 hex).
pub fn generate_relay_token() -> String {
    format!("rhr_{}", random_hex32())
}

fn random_hex32() -> String {
    use rand::RngCore;
    let mut bytes = zeroize::Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(bytes.as_mut());
    hex::encode(bytes.as_ref())
}

/// Generate a stable per-device id with the protocol's class prefix
/// (`rhw_`/`rhn_`/`rhd_` for watch/necklace/desk). The firmware generates its own
/// id at first boot; this mirror is used by tests and any node-driven flow.
pub fn generate_device_id(device_type: super::protocol::DeviceType) -> String {
    use super::protocol::DeviceType;
    let prefix = match device_type {
        DeviceType::Watch => "rhw",
        DeviceType::Necklace => "rhn",
        DeviceType::Desk => "rhd",
    };
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/// Legacy v1: verify the pairing nonce and register the device, returning its
/// token and the node URL the device should connect to.
///
/// `node_url` is resolved by Core (`server::hardware_public`) from the node's
/// reachable address (tailnet/LAN).
pub async fn pair(
    store: &DeviceStore,
    req: &PairRequest,
    node_url: &str,
) -> Result<PairResponse, PairError> {
    let nonce = req.pairing_nonce.trim();
    if nonce.len() < MIN_NONCE_LEN {
        return Err(PairError::BadNonce);
    }

    // Reject a device that is already paired (a stranger who later sees the QR
    // must not be able to mint a token for an in-use device).
    match store.get(&req.device_id).await {
        Ok(Some(_)) => return Err(PairError::AlreadyPaired),
        Ok(None) => {}
        Err(_) => return Err(PairError::Storage),
    }

    // Burn the (device_id, nonce) pair in the durable ledger; a replay fails.
    match store.consume_nonce(&req.device_id, nonce).await {
        Ok(true) => {}
        Ok(false) => return Err(PairError::BadNonce),
        Err(_) => return Err(PairError::Storage),
    }

    let token = generate_device_token();
    let now = chrono::Utc::now().timestamp_millis();
    let record = DeviceRecord::new_legacy(
        req.device_id.clone(),
        req.device_type,
        default_name(req.device_type),
        hash_token(&token),
        now,
    );
    if store.insert(record).await.is_err() {
        return Err(PairError::Storage);
    }

    Ok(PairResponse {
        device_token: token,
        node_url: node_url.to_string(),
    })
}

/// A friendly default device name applied at pairing; the user can rename it via
/// `PATCH /api/hardware/devices/:id`.
fn default_name(device_type: super::protocol::DeviceType) -> String {
    use super::protocol::DeviceType;
    match device_type {
        DeviceType::Watch => "Ryu Watch",
        DeviceType::Necklace => "Ryu Necklace",
        DeviceType::Desk => "Ryu Desk",
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// Pairing v2
// ---------------------------------------------------------------------------

/// `^[A-Za-z0-9_-]{1,63}$`.
fn valid_device_id(device_id: &str) -> bool {
    (1..=63).contains(&device_id.len())
        && device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Exactly 32 lowercase hex characters.
fn valid_pairing_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Wi-Fi: ssid 1 to 32 bytes; psk empty (open network) or 8 to 63 bytes, neither
/// containing NUL. Lengths are UTF-8 bytes because the device copies the opened
/// credentials into fixed C strings (`wifi_ssid[33]`, `wifi_psk[64]`) by `strlen`:
/// anything it would refuse must fail here, before the device row is committed.
fn validate_wifi(wifi: &WifiCredentials) -> Result<(), PairError> {
    if !(1..=32).contains(&wifi.ssid.len()) || wifi.ssid.contains('\0') {
        return Err(PairError::BadRequest(
            "wifi.ssid must be 1 to 32 bytes with no NUL",
        ));
    }
    let psk_len = wifi.psk.len();
    if (psk_len != 0 && !(8..=63).contains(&psk_len)) || wifi.psk.contains('\0') {
        return Err(PairError::BadRequest(
            "wifi.psk must be empty or 8 to 63 bytes with no NUL",
        ));
    }
    Ok(())
}

/// Normalise `key_verification`: `sas` when the codes matched (`verified` is an
/// accepted alias), `unverified` for "I can't verify".
fn normalize_key_verification(value: &str) -> Result<&'static str, PairError> {
    match value {
        "sas" | "verified" => Ok("sas"),
        "unverified" => Ok("unverified"),
        _ => Err(PairError::BadRequest(
            "key_verification must be sas or unverified",
        )),
    }
}

fn decode_pairing_id(pairing_id: &str) -> Result<[u8; RANDOM_LEN], PairError> {
    pair_crypto::b64u_decode_array::<RANDOM_LEN>(pairing_id).ok_or(PairError::BadRequest(
        "pairing_id must be base64url of 16 bytes",
    ))
}

/// Decode a value this crate stored itself; a failure is a storage fault.
fn stored_array<const N: usize>(value: Option<&str>) -> Result<[u8; N], PairError> {
    value
        .and_then(pair_crypto::b64u_decode_array::<N>)
        .ok_or(PairError::Storage)
}

fn pending_transcript_hash(
    pending: &PendingPairing,
    pairing_id: &[u8; RANDOM_LEN],
    device_pub: &[u8; 32],
    node_pub: &[u8; 32],
    device_rand: &[u8; RANDOM_LEN],
) -> [u8; 32] {
    let transcript = pair_crypto::transcript(&TranscriptInputs {
        device_id: &pending.device_id,
        device_type: device_type_str(pending.device_type),
        pairing_nonce: &pending.pairing_nonce,
        pairing_id,
        device_pub,
        node_pub,
        device_rand,
    });
    pair_crypto::transcript_hash(&transcript)
}

/// `POST /api/hardware/pair/begin`: validate the device's key and commitment and
/// persist a pending pairing with a fresh node-chosen `pairing_id`.
pub async fn begin_pair(
    store: &DeviceStore,
    req: &PairBeginRequest,
    node_url: &str,
    now_ms: i64,
) -> Result<PairBeginResponse, PairError> {
    use rand::RngCore;
    let mut pairing_id = [0u8; RANDOM_LEN];
    rand::rngs::OsRng.fill_bytes(&mut pairing_id);
    begin_pair_with_id(store, req, node_url, now_ms, pairing_id).await
}

/// [`begin_pair`] with an injected `pairing_id` (the vector tests use the golden one).
pub(crate) async fn begin_pair_with_id(
    store: &DeviceStore,
    req: &PairBeginRequest,
    node_url: &str,
    now_ms: i64,
    pairing_id: [u8; RANDOM_LEN],
) -> Result<PairBeginResponse, PairError> {
    if !valid_device_id(&req.device_id) {
        return Err(PairError::BadRequest(
            "device_id must match ^[A-Za-z0-9_-]{1,63}$",
        ));
    }
    let device_type = parse_device_type(&req.device_type).ok_or(PairError::BadRequest(
        "device_type must be watch, necklace or desk",
    ))?;
    if !valid_pairing_nonce(&req.pairing_nonce) {
        return Err(PairError::BadRequest(
            "pairing_nonce must be 32 lowercase hex characters",
        ));
    }
    let device_pub = pair_crypto::b64u_decode_array::<32>(&req.device_pub).ok_or(
        PairError::BadRequest("device_pub must be base64url of 32 bytes"),
    )?;
    pair_crypto::b64u_decode_array::<32>(&req.device_commit).ok_or(PairError::BadRequest(
        "device_commit must be base64url of 32 bytes",
    ))?;
    if req.key_source != "qr" && req.key_source != "ble" {
        return Err(PairError::BadRequest("key_source must be qr or ble"));
    }
    if req.policy != pair_crypto::POLICY_SAS_PRESS {
        return Err(PairError::BadRequest("policy must be sas_press"));
    }

    match store.get(&req.device_id).await {
        Ok(Some(_)) => return Err(PairError::AlreadyPaired),
        Ok(None) => {}
        Err(_) => return Err(PairError::Storage),
    }
    if store
        .noise_key_bound(&req.device_pub)
        .await
        .map_err(|_| PairError::Storage)?
    {
        return Err(PairError::AlreadyPaired);
    }
    if store
        .nonce_consumed(&req.device_id, &req.pairing_nonce)
        .await
        .map_err(|_| PairError::Storage)?
    {
        return Err(PairError::BadRequest("pairing_nonce was already used"));
    }

    let identity = store
        .node_identity()
        .await
        .map_err(|_| PairError::IdentityUnavailable)?;
    if identity.dh(&device_pub).is_none() {
        return Err(PairError::BadDeviceKey);
    }

    let pending = PendingPairing {
        pairing_id: pair_crypto::b64u_encode(&pairing_id),
        device_id: req.device_id.clone(),
        device_type,
        pairing_nonce: req.pairing_nonce.clone(),
        device_pub: req.device_pub.clone(),
        device_commit: req.device_commit.clone(),
        key_source: req.key_source.clone(),
        node_url: node_url.to_string(),
        device_rand: None,
        transcript_hash: None,
        state: PendingState::Begun,
        created_at: now_ms,
        expires_at: now_ms + PENDING_PAIRING_TTL_MS,
    };
    match store.insert_pending_pairing(&pending, now_ms).await {
        Ok(PendingInsert::Inserted) => {}
        Ok(PendingInsert::TooManyPending) => return Err(PairError::TooManyPending),
        Err(_) => return Err(PairError::Storage),
    }

    Ok(PairBeginResponse {
        pairing_id: pending.pairing_id,
        node_pub: identity.public_b64u(),
        node_fingerprint: identity.fingerprint(),
        expires_in: PENDING_EXPIRES_IN_SECS,
    })
}

/// `POST /api/hardware/pair/reveal`: open the commitment with `device_rand`,
/// compute the transcript, and return the SAS. Single use.
pub async fn reveal_pair(
    store: &DeviceStore,
    req: &PairRevealRequest,
    now_ms: i64,
) -> Result<PairRevealResponse, PairError> {
    let pairing_id = decode_pairing_id(&req.pairing_id)?;
    let device_rand = pair_crypto::b64u_decode_array::<RANDOM_LEN>(&req.device_rand).ok_or(
        PairError::BadRequest("device_rand must be base64url of 16 bytes"),
    )?;

    let pending = store
        .get_pending_pairing(&req.pairing_id, now_ms)
        .await
        .map_err(|_| PairError::Storage)?
        .ok_or(PairError::UnknownOrExpired)?;
    if pending.state != PendingState::Begun {
        return Err(PairError::BadState);
    }
    let device_pub = stored_array::<32>(Some(&pending.device_pub))?;
    let device_commit = stored_array::<32>(Some(&pending.device_commit))?;

    let opened = pair_crypto::commit(&device_pub, &device_rand);
    if !bool::from(subtle::ConstantTimeEq::ct_eq(
        &opened[..],
        &device_commit[..],
    )) {
        // A wrong reveal burns the attempt: the device starts a new one.
        let _ = store.delete_pending_pairing(&req.pairing_id).await;
        return Err(PairError::CommitmentMismatch);
    }

    let identity = store
        .node_identity()
        .await
        .map_err(|_| PairError::IdentityUnavailable)?;
    let transcript_hash = pending_transcript_hash(
        &pending,
        &pairing_id,
        &device_pub,
        &identity.public(),
        &device_rand,
    );
    let transcript_hash_b64u = pair_crypto::b64u_encode(&transcript_hash);
    let marked = store
        .mark_pending_revealed(&req.pairing_id, &req.device_rand, &transcript_hash_b64u)
        .await
        .map_err(|_| PairError::Storage)?;
    if !marked {
        return Err(PairError::BadState);
    }

    Ok(PairRevealResponse {
        sas: pair_crypto::sas(&transcript_hash),
        transcript_hash: transcript_hash_b64u,
        device_fingerprint: pair_crypto::fingerprint(&device_pub),
    })
}

/// `POST /api/hardware/pair/confirm`: verify the press-bound `confirm_tag`, then
/// atomically register the level-2 device, mint its tokens and seal the
/// credentials to it. Single use: a replay is [`PairError::UnknownOrExpired`].
pub async fn confirm_pair(
    store: &DeviceStore,
    req: &PairConfirmRequest,
    now_ms: i64,
) -> Result<PairConfirmResponse, PairError> {
    let pairing_id = decode_pairing_id(&req.pairing_id)?;
    let presented_tag = pair_crypto::b64u_decode_array::<32>(&req.confirm_tag).ok_or(
        PairError::BadRequest("confirm_tag must be base64url of 32 bytes"),
    )?;
    let key_verification = normalize_key_verification(&req.key_verification)?;
    if let Some(wifi) = &req.wifi {
        validate_wifi(wifi)?;
    }

    let pending = store
        .get_pending_pairing(&req.pairing_id, now_ms)
        .await
        .map_err(|_| PairError::Storage)?
        .ok_or(PairError::UnknownOrExpired)?;
    if pending.state != PendingState::Revealed {
        return Err(PairError::BadState);
    }
    if pending.node_url.len() > MAX_NODE_URL_LEN {
        return Err(PairError::NodeUrlTooLong);
    }
    let device_pub = stored_array::<32>(Some(&pending.device_pub))?;
    let device_rand = stored_array::<RANDOM_LEN>(pending.device_rand.as_deref())?;
    let stored_hash = stored_array::<32>(pending.transcript_hash.as_deref())?;

    let identity = store
        .node_identity()
        .await
        .map_err(|_| PairError::IdentityUnavailable)?;
    let transcript_hash = pending_transcript_hash(
        &pending,
        &pairing_id,
        &device_pub,
        &identity.public(),
        &device_rand,
    );
    if transcript_hash != stored_hash {
        // The node key changed under the pending pairing; it cannot complete.
        let _ = store.delete_pending_pairing(&req.pairing_id).await;
        return Err(PairError::BadState);
    }
    let dh = identity.dh(&device_pub).ok_or(PairError::BadDeviceKey)?;
    let keys = pair_crypto::derive(&dh, &transcript_hash);
    if !pair_crypto::verify_confirm_tag(&keys, &presented_tag) {
        let _ = store.delete_pending_pairing(&req.pairing_id).await;
        return Err(PairError::ConfirmationMismatch);
    }

    let device_token = generate_device_token();
    let relay_token = generate_relay_token();
    let record = DeviceRecord {
        noise_pubkey: Some(pending.device_pub.clone()),
        protocol_level: PROTOCOL_LEVEL_SECURE,
        key_verification: Some(key_verification.to_string()),
        key_source: Some(pending.key_source.clone()),
        relay_token_hash: Some(hash_token(&relay_token)),
        paired_at: Some(now_ms),
        ..DeviceRecord::new_legacy(
            pending.device_id.clone(),
            pending.device_type,
            default_name(pending.device_type),
            hash_token(&device_token),
            now_ms,
        )
    };
    match store
        .insert_paired_v2(&record, &pending.pairing_nonce, &req.pairing_id, now_ms)
        .await
    {
        Ok(PairedInsert::Inserted) => {}
        Ok(PairedInsert::PendingGone) => return Err(PairError::UnknownOrExpired),
        Ok(PairedInsert::AlreadyPaired | PairedInsert::KeyBound) => {
            return Err(PairError::AlreadyPaired)
        }
        Ok(PairedInsert::NonceConsumed) => return Err(PairError::BadState),
        Err(_) => return Err(PairError::Storage),
    }

    let credentials = SealedCredentials {
        device_token,
        node_url: pending.node_url.clone(),
        wifi_ssid: req.wifi.as_ref().map(|wifi| wifi.ssid.clone()),
        wifi_psk: req.wifi.as_ref().map(|wifi| wifi.psk.clone()),
    };
    let sealed = pair_crypto::seal_credentials(&keys, &transcript_hash, &credentials);

    Ok(PairConfirmResponse {
        relay_token,
        sealed_credentials: pair_crypto::b64u_encode(&sealed),
        device: crate::api::device_list_item(&record, None),
    })
}

/// `POST /api/hardware/pair/cancel`: drop the pending pairing. Idempotent; returns
/// the removed pending pairing, if any, so the caller can audit it.
pub async fn cancel_pair(
    store: &DeviceStore,
    req: &PairCancelRequest,
    now_ms: i64,
) -> Result<Option<PendingPairing>, PairError> {
    let pending = store
        .get_pending_pairing(&req.pairing_id, now_ms)
        .await
        .map_err(|_| PairError::Storage)?;
    store
        .delete_pending_pairing(&req.pairing_id)
        .await
        .map_err(|_| PairError::Storage)?;
    Ok(pending)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{NodeIdentity, PlaintextSealerForTests};
    use crate::protocol::DeviceType;
    use serde_json::Value;
    use std::path::PathBuf;
    use std::sync::Arc;

    const PAIRING: &str = include_str!("../tests/vectors/rhp_v1_1_pairing.json");
    const NODE_URL: &str = "wss://node.example.ts.net:7980/api/hardware/ws";
    const NOW: i64 = 1_700_000_000_000;

    fn vectors() -> Value {
        serde_json::from_str(PAIRING).unwrap()
    }

    fn hex32(value: &Value) -> [u8; 32] {
        hex::decode(value.as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap()
    }

    fn hex16(value: &Value) -> [u8; 16] {
        hex::decode(value.as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap()
    }

    fn temp_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("ryu-hw-pair-{}", uuid::Uuid::new_v4()))
            .join("hardware.db")
    }

    fn temp_store() -> DeviceStore {
        DeviceStore::open(temp_path()).expect("open")
    }

    /// A store whose node identity is the vector node key.
    fn vector_store() -> DeviceStore {
        let v = vectors();
        let store = temp_store();
        store.install_identity_for_tests(NodeIdentity::from_secret_bytes(hex32(
            &v["inputs"]["node_static_sk"],
        )));
        store
    }

    fn vector_begin() -> PairBeginRequest {
        let v = vectors();
        PairBeginRequest {
            device_id: v["inputs"]["device_id"].as_str().unwrap().into(),
            device_type: v["inputs"]["device_type"].as_str().unwrap().into(),
            pairing_nonce: v["inputs"]["pairing_nonce"].as_str().unwrap().into(),
            device_pub: v["device_pub_b64url"].as_str().unwrap().into(),
            device_commit: v["device_commit_b64url"].as_str().unwrap().into(),
            key_source: "qr".into(),
            policy: "sas_press".into(),
        }
    }

    fn vector_pairing_id() -> [u8; 16] {
        hex16(&vectors()["inputs"]["pairing_id_hex"])
    }

    fn vector_reveal() -> PairRevealRequest {
        let v = vectors();
        PairRevealRequest {
            pairing_id: v["pairing_id_b64url"].as_str().unwrap().into(),
            device_rand: v["device_rand_b64url"].as_str().unwrap().into(),
        }
    }

    fn vector_confirm(wifi: Option<WifiCredentials>) -> PairConfirmRequest {
        let v = vectors();
        PairConfirmRequest {
            pairing_id: v["pairing_id_b64url"].as_str().unwrap().into(),
            confirm_tag: v["confirm_tag_b64url"].as_str().unwrap().into(),
            key_verification: "sas".into(),
            wifi,
        }
    }

    async fn begin_and_reveal(store: &DeviceStore) {
        begin_pair_with_id(store, &vector_begin(), NODE_URL, NOW, vector_pairing_id())
            .await
            .expect("begin");
        reveal_pair(store, &vector_reveal(), NOW + 1)
            .await
            .expect("reveal");
    }

    /// A fresh device with a random key, committing to a random value.
    struct Device {
        secret: [u8; 32],
        public: [u8; 32],
        rand: [u8; 16],
        id: String,
    }

    impl Device {
        fn new(id: &str) -> Self {
            use rand::RngCore;
            let mut secret = [0u8; 32];
            let mut rand_bytes = [0u8; 16];
            rand::rngs::OsRng.fill_bytes(&mut secret);
            rand::rngs::OsRng.fill_bytes(&mut rand_bytes);
            Self {
                public: pair_crypto::public_key(&secret),
                secret,
                rand: rand_bytes,
                id: id.into(),
            }
        }

        fn begin(&self) -> PairBeginRequest {
            PairBeginRequest {
                device_id: self.id.clone(),
                device_type: "necklace".into(),
                pairing_nonce: "0123456789abcdef0123456789abcdef".into(),
                device_pub: pair_crypto::b64u_encode(&self.public),
                device_commit: pair_crypto::b64u_encode(&pair_crypto::commit(
                    &self.public,
                    &self.rand,
                )),
                key_source: "ble".into(),
                policy: "sas_press".into(),
            }
        }
    }

    #[test]
    fn token_and_id_have_prefixes() {
        let device = generate_device_token();
        let relay = generate_relay_token();
        assert!(device.starts_with("rht_") && device.len() == 68);
        assert!(relay.starts_with("rhr_") && relay.len() == 68);
        assert!(generate_device_id(DeviceType::Watch).starts_with("rhw_"));
        assert!(generate_device_id(DeviceType::Necklace).starts_with("rhn_"));
    }

    #[test]
    fn error_codes_and_statuses_follow_the_spec() {
        let cases = [
            (PairError::BadRequest("x"), "bad_request", 400),
            (PairError::AlreadyPaired, "already_paired", 409),
            (PairError::BadDeviceKey, "bad_device_key", 422),
            (PairError::TooManyPending, "too_many_pending", 429),
            (
                PairError::IdentityUnavailable,
                "node_identity_unavailable",
                503,
            ),
            (PairError::UnknownOrExpired, "unknown_or_expired", 404),
            (PairError::CommitmentMismatch, "commitment_mismatch", 401),
            (PairError::BadState, "bad_state", 409),
            (
                PairError::ConfirmationMismatch,
                "confirmation_mismatch",
                401,
            ),
            (PairError::NodeUrlTooLong, "node_url_too_long", 422),
            (PairError::BadNonce, "bad_nonce", 401),
            (PairError::Storage, "storage", 500),
        ];
        for (error, code, status) in cases {
            assert_eq!(error.code(), code);
            assert_eq!(error.http_status_hint(), status, "{code}");
            assert!(!error.message().is_empty());
        }
        assert_eq!(PairError::BadRequest("field x").message(), "field x");
    }

    #[tokio::test]
    async fn pair_registers_and_returns_token() {
        let store = temp_store();
        let req = PairRequest {
            device_id: "rhw_abc".into(),
            pairing_nonce: "0123456789abcdef".into(),
            device_type: DeviceType::Watch,
        };
        let resp = pair(&store, &req, "ws://node.local/api/hardware/ws")
            .await
            .expect("pairs");
        assert!(resp.device_token.starts_with("rht_"));
        assert_eq!(resp.node_url, "ws://node.local/api/hardware/ws");
        assert!(store
            .verify_token("rhw_abc", &resp.device_token)
            .await
            .unwrap());
        let record = store.get("rhw_abc").await.unwrap().unwrap();
        assert_eq!(record.protocol_level, 1);
    }

    #[tokio::test]
    async fn rejects_short_nonce_and_replay_and_double_pair() {
        let store = temp_store();
        let short = PairRequest {
            device_id: "rhw_x".into(),
            pairing_nonce: "abc".into(),
            device_type: DeviceType::Watch,
        };
        assert_eq!(
            pair(&store, &short, "u").await.unwrap_err(),
            PairError::BadNonce
        );

        let req = PairRequest {
            device_id: "rhw_y".into(),
            pairing_nonce: "ffffffffffffffff".into(),
            device_type: DeviceType::Watch,
        };
        assert!(pair(&store, &req, "u").await.is_ok());
        assert_eq!(
            pair(&store, &req, "u").await.unwrap_err(),
            PairError::AlreadyPaired
        );
        // After a revoke the same QR still cannot be replayed.
        assert!(store.revoke("rhw_y").await.unwrap());
        assert_eq!(
            pair(&store, &req, "u").await.unwrap_err(),
            PairError::BadNonce
        );
    }

    #[tokio::test]
    async fn legacy_nonces_persist_across_a_reopen() {
        let path = temp_path();
        let req = PairRequest {
            device_id: "rhw_restart".into(),
            pairing_nonce: "aaaaaaaaaaaaaaaa".into(),
            device_type: DeviceType::Watch,
        };
        {
            let store = DeviceStore::open(path.clone()).unwrap();
            pair(&store, &req, "u").await.unwrap();
            store.revoke("rhw_restart").await.unwrap();
        }
        let reopened = DeviceStore::open(path).unwrap();
        assert_eq!(
            pair(&reopened, &req, "u").await.unwrap_err(),
            PairError::BadNonce
        );
    }

    #[tokio::test]
    async fn vector_happy_path() {
        let v = vectors();
        let store = vector_store();

        let begun = begin_pair_with_id(&store, &vector_begin(), NODE_URL, NOW, vector_pairing_id())
            .await
            .expect("begin");
        assert_eq!(begun.pairing_id, v["pairing_id_b64url"].as_str().unwrap());
        assert_eq!(begun.node_pub, v["node_pub_b64url"].as_str().unwrap());
        assert_eq!(
            begun.node_fingerprint,
            v["node_key_fingerprint"].as_str().unwrap()
        );
        assert_eq!(begun.expires_in, 180);

        let revealed = reveal_pair(&store, &vector_reveal(), NOW + 1)
            .await
            .expect("reveal");
        assert_eq!(revealed.sas, v["sas"].as_str().unwrap());
        assert_eq!(
            revealed.transcript_hash,
            v["transcript_hash_b64url"].as_str().unwrap()
        );
        assert_eq!(
            revealed.device_fingerprint,
            v["device_key_fingerprint"].as_str().unwrap()
        );
        // Reveal is single use.
        assert_eq!(
            reveal_pair(&store, &vector_reveal(), NOW + 2)
                .await
                .unwrap_err(),
            PairError::BadState
        );

        let wifi = WifiCredentials {
            ssid: "HomeNet".into(),
            psk: "correct horse battery staple".into(),
        };
        let confirmed = confirm_pair(&store, &vector_confirm(Some(wifi)), NOW + 3)
            .await
            .expect("confirm");
        assert!(confirmed.relay_token.starts_with("rhr_"));
        assert_eq!(confirmed.device.protocol_level, 2);
        assert!(confirmed.device.secure);
        assert_eq!(confirmed.device.key_source.as_deref(), Some("qr"));
        assert_eq!(confirmed.device.key_verification.as_deref(), Some("sas"));
        assert_eq!(
            confirmed.device.key_fingerprint.as_deref(),
            v["device_key_fingerprint"].as_str()
        );

        // The device opens the seal with its own DH and recovers working tokens.
        let device_sk = hex32(&v["inputs"]["device_static_sk"]);
        let node_pub = hex32(&v["node_pub_hex"]);
        let t_hash = hex32(&v["transcript_hash_hex"]);
        let dh = pair_crypto::dh(&device_sk, &node_pub).unwrap();
        let keys = pair_crypto::derive(&dh, &t_hash);
        let sealed = pair_crypto::b64u_decode(&confirmed.sealed_credentials).unwrap();
        let opened = pair_crypto::open_credentials(&keys, &t_hash, &sealed).expect("opens");
        assert_eq!(opened.node_url, NODE_URL);
        assert_eq!(opened.wifi_ssid.as_deref(), Some("HomeNet"));
        assert_eq!(
            opened.wifi_psk.as_deref(),
            Some("correct horse battery staple")
        );
        assert!(opened.device_token.starts_with("rht_"));

        let device_id = v["inputs"]["device_id"].as_str().unwrap();
        assert!(store
            .verify_token(device_id, &opened.device_token)
            .await
            .unwrap());
        let (record, kind) = store
            .authenticate_bearer(&confirmed.relay_token)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.device_id, device_id);
        assert_eq!(kind, crate::store::TokenKind::Relay);
        assert_eq!(
            record.noise_pubkey.as_deref(),
            v["device_pub_b64url"].as_str()
        );
        assert!(store
            .nonce_consumed(device_id, v["inputs"]["pairing_nonce"].as_str().unwrap())
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn confirm_is_single_use() {
        let store = vector_store();
        begin_and_reveal(&store).await;
        confirm_pair(&store, &vector_confirm(None), NOW + 3)
            .await
            .expect("first confirm");
        assert_eq!(
            confirm_pair(&store, &vector_confirm(None), NOW + 4)
                .await
                .unwrap_err(),
            PairError::UnknownOrExpired
        );
    }

    #[tokio::test]
    async fn commitment_mismatch_deletes_the_pending_pairing() {
        let store = vector_store();
        begin_pair_with_id(&store, &vector_begin(), NODE_URL, NOW, vector_pairing_id())
            .await
            .unwrap();
        let wrong = PairRevealRequest {
            device_rand: pair_crypto::b64u_encode(&[7u8; 16]),
            ..vector_reveal()
        };
        assert_eq!(
            reveal_pair(&store, &wrong, NOW + 1).await.unwrap_err(),
            PairError::CommitmentMismatch
        );
        assert!(store
            .get_pending_pairing(&vector_reveal().pairing_id, NOW + 1)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            reveal_pair(&store, &vector_reveal(), NOW + 2)
                .await
                .unwrap_err(),
            PairError::UnknownOrExpired
        );
    }

    #[tokio::test]
    async fn confirmation_mismatch_deletes_the_pending_pairing() {
        let v = vectors();
        let store = vector_store();
        begin_and_reveal(&store).await;
        // The tag a device computes against a substituted node key.
        let wrong = PairConfirmRequest {
            confirm_tag: pair_crypto::b64u_encode(
                &hex::decode(
                    v["negative_node_key_substituted"]["device_confirm_tag_hex"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap(),
            ),
            ..vector_confirm(None)
        };
        assert_eq!(
            confirm_pair(&store, &wrong, NOW + 3).await.unwrap_err(),
            PairError::ConfirmationMismatch
        );
        assert_eq!(
            confirm_pair(&store, &vector_confirm(None), NOW + 4)
                .await
                .unwrap_err(),
            PairError::UnknownOrExpired
        );
        assert!(store
            .get(v["inputs"]["device_id"].as_str().unwrap())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn steps_out_of_order_are_bad_state() {
        let store = vector_store();
        begin_pair_with_id(&store, &vector_begin(), NODE_URL, NOW, vector_pairing_id())
            .await
            .unwrap();
        assert_eq!(
            confirm_pair(&store, &vector_confirm(None), NOW + 1)
                .await
                .unwrap_err(),
            PairError::BadState
        );
    }

    #[tokio::test]
    async fn pending_pairings_expire() {
        let store = vector_store();
        begin_pair_with_id(&store, &vector_begin(), NODE_URL, NOW, vector_pairing_id())
            .await
            .unwrap();
        assert_eq!(
            reveal_pair(&store, &vector_reveal(), NOW + PENDING_PAIRING_TTL_MS)
                .await
                .unwrap_err(),
            PairError::UnknownOrExpired
        );

        let store = vector_store();
        begin_and_reveal(&store).await;
        assert_eq!(
            confirm_pair(
                &store,
                &vector_confirm(None),
                NOW + PENDING_PAIRING_TTL_MS + 1
            )
            .await
            .unwrap_err(),
            PairError::UnknownOrExpired
        );
    }

    #[tokio::test]
    async fn too_many_pending() {
        let store = temp_store();
        store.set_key_sealer(Arc::new(PlaintextSealerForTests));
        for index in 0..4 {
            let device = Device::new(&format!("rhn_{index}"));
            begin_pair(&store, &device.begin(), NODE_URL, NOW)
                .await
                .expect("begin");
        }
        let fifth = Device::new("rhn_4");
        assert_eq!(
            begin_pair(&store, &fifth.begin(), NODE_URL, NOW)
                .await
                .unwrap_err(),
            PairError::TooManyPending
        );
        // A newer begin for an existing device replaces its pending pairing.
        let again = Device::new("rhn_0");
        assert!(begin_pair(&store, &again.begin(), NODE_URL, NOW + 1)
            .await
            .is_ok());
        // Once they expire, there is room again.
        assert!(begin_pair(
            &store,
            &fifth.begin(),
            NODE_URL,
            NOW + PENDING_PAIRING_TTL_MS + 2
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn low_order_device_key_is_rejected() {
        let store = vector_store();
        let req = PairBeginRequest {
            device_pub: pair_crypto::b64u_encode(&[0u8; 32]),
            ..vector_begin()
        };
        assert_eq!(
            begin_pair(&store, &req, NODE_URL, NOW).await.unwrap_err(),
            PairError::BadDeviceKey
        );
    }

    #[tokio::test]
    async fn begin_validates_its_inputs() {
        let store = vector_store();
        let base = vector_begin();
        let cases = [
            PairBeginRequest {
                device_id: "bad id".into(),
                ..base.clone()
            },
            PairBeginRequest {
                device_type: "toaster".into(),
                ..base.clone()
            },
            PairBeginRequest {
                pairing_nonce: "00112233445566778899AABBCCDDEEFF".into(),
                ..base.clone()
            },
            PairBeginRequest {
                device_pub: format!("{}=", base.device_pub),
                ..base.clone()
            },
            PairBeginRequest {
                device_commit: "short".into(),
                ..base.clone()
            },
            PairBeginRequest {
                key_source: "nfc".into(),
                ..base.clone()
            },
            PairBeginRequest {
                policy: "none".into(),
                ..base.clone()
            },
        ];
        for req in cases {
            assert!(matches!(
                begin_pair(&store, &req, NODE_URL, NOW).await,
                Err(PairError::BadRequest(_))
            ));
        }
    }

    #[tokio::test]
    async fn begin_refuses_paired_devices_and_missing_identity() {
        let store = vector_store();
        begin_and_reveal(&store).await;
        confirm_pair(&store, &vector_confirm(None), NOW + 3)
            .await
            .unwrap();
        assert_eq!(
            begin_pair(&store, &vector_begin(), NODE_URL, NOW + 4)
                .await
                .unwrap_err(),
            PairError::AlreadyPaired
        );

        let no_sealer = temp_store();
        assert_eq!(
            begin_pair(&no_sealer, &vector_begin(), NODE_URL, NOW)
                .await
                .unwrap_err(),
            PairError::IdentityUnavailable
        );
    }

    #[tokio::test]
    async fn confirm_validates_wifi_verification_and_node_url() {
        let store = vector_store();
        begin_and_reveal(&store).await;
        let bad_psk = WifiCredentials {
            ssid: "Home".into(),
            psk: "short".into(),
        };
        assert!(matches!(
            confirm_pair(&store, &vector_confirm(Some(bad_psk)), NOW + 3).await,
            Err(PairError::BadRequest(_))
        ));
        let bad_ssid = WifiCredentials {
            ssid: "x".repeat(33),
            psk: String::new(),
        };
        assert!(matches!(
            confirm_pair(&store, &vector_confirm(Some(bad_ssid)), NOW + 3).await,
            Err(PairError::BadRequest(_))
        ));
        let bad_verification = PairConfirmRequest {
            key_verification: "maybe".into(),
            ..vector_confirm(None)
        };
        assert!(matches!(
            confirm_pair(&store, &bad_verification, NOW + 3).await,
            Err(PairError::BadRequest(_))
        ));
        // None of these consumed the pending pairing; an open network is fine.
        let open = WifiCredentials {
            ssid: "Cafe".into(),
            psk: String::new(),
        };
        let unverified = PairConfirmRequest {
            key_verification: "unverified".into(),
            ..vector_confirm(Some(open))
        };
        let confirmed = confirm_pair(&store, &unverified, NOW + 4).await.unwrap();
        assert_eq!(
            confirmed.device.key_verification.as_deref(),
            Some("unverified")
        );

        let long = vector_store();
        let long_url = format!("wss://{}/api/hardware/ws", "a".repeat(150));
        begin_pair_with_id(&long, &vector_begin(), &long_url, NOW, vector_pairing_id())
            .await
            .unwrap();
        reveal_pair(&long, &vector_reveal(), NOW + 1).await.unwrap();
        assert_eq!(
            confirm_pair(&long, &vector_confirm(None), NOW + 2)
                .await
                .unwrap_err(),
            PairError::NodeUrlTooLong
        );
    }

    /// The device parses the sealed credentials into fixed C buffers (`wifi_ssid[33]`,
    /// `wifi_psk[64]`) with `strlen`, so the node must measure UTF-8 bytes and refuse
    /// a NUL before it commits the device row. Otherwise the confirm succeeds, the row
    /// is committed, and the device answers the provision write with `bad_seal`.
    #[tokio::test]
    async fn confirm_measures_wifi_in_device_bytes_before_committing() {
        let store = vector_store();
        begin_and_reveal(&store).await;
        let refused = [
            // 40 characters but 80 bytes: over the device's 63-byte PSK limit.
            ("Home".to_owned(), "\u{f6}".repeat(40)),
            // 63 characters but 64 bytes.
            ("Home".to_owned(), format!("{}\u{f6}", "a".repeat(62))),
            // A NUL truncates the C string: 8 bytes here, 3 on the device.
            ("Home".to_owned(), "abc\0defg".to_owned()),
            // 16 characters but 48 bytes: over the device's 32-byte SSID limit.
            ("\u{3042}".repeat(16), "correct horse".to_owned()),
            ("Ho\0me".to_owned(), "correct horse".to_owned()),
        ];
        for (ssid, psk) in refused {
            let wifi = WifiCredentials { ssid, psk };
            assert!(
                matches!(
                    confirm_pair(&store, &vector_confirm(Some(wifi.clone())), NOW + 3).await,
                    Err(PairError::BadRequest(_))
                ),
                "{wifi:?} must be refused before the row is committed"
            );
        }
        // Nothing above was committed or consumed the pending pairing.
        assert!(store
            .get_pending_pairing(&vector_confirm(None).pairing_id, NOW + 3)
            .await
            .unwrap()
            .is_some());

        // 4 characters but 8 bytes: the device accepts it, so the node does too.
        let multibyte = WifiCredentials {
            ssid: "\u{3042}".repeat(10),
            psk: "\u{f6}".repeat(4),
        };
        let confirmed = confirm_pair(&store, &vector_confirm(Some(multibyte)), NOW + 4).await;
        assert!(confirmed.is_ok(), "{confirmed:?}");
    }

    #[tokio::test]
    async fn random_device_end_to_end_and_cancel() {
        let store = temp_store();
        store.set_key_sealer(Arc::new(PlaintextSealerForTests));
        let device = Device::new("rhn_e2e");
        let begun = begin_pair(&store, &device.begin(), NODE_URL, NOW)
            .await
            .unwrap();
        let revealed = reveal_pair(
            &store,
            &PairRevealRequest {
                pairing_id: begun.pairing_id.clone(),
                device_rand: pair_crypto::b64u_encode(&device.rand),
            },
            NOW + 1,
        )
        .await
        .unwrap();

        // The device computes the same transcript and SAS from its side.
        let node_pub = pair_crypto::b64u_decode_array::<32>(&begun.node_pub).unwrap();
        let pairing_id = pair_crypto::b64u_decode_array::<16>(&begun.pairing_id).unwrap();
        let transcript = pair_crypto::transcript(&TranscriptInputs {
            device_id: &device.id,
            device_type: "necklace",
            pairing_nonce: "0123456789abcdef0123456789abcdef",
            pairing_id: &pairing_id,
            device_pub: &device.public,
            node_pub: &node_pub,
            device_rand: &device.rand,
        });
        let t_hash = pair_crypto::transcript_hash(&transcript);
        assert_eq!(revealed.sas, pair_crypto::sas(&t_hash));
        let dh = pair_crypto::dh(&device.secret, &node_pub).unwrap();
        let keys = pair_crypto::derive(&dh, &t_hash);
        let tag = pair_crypto::confirm_tag(&keys);

        // Cancel is idempotent and makes confirm fail.
        let cancel = PairCancelRequest {
            pairing_id: begun.pairing_id.clone(),
            reason: Some("mismatch".into()),
        };
        assert!(cancel_pair(&store, &cancel, NOW + 2)
            .await
            .unwrap()
            .is_some());
        assert!(cancel_pair(&store, &cancel, NOW + 2)
            .await
            .unwrap()
            .is_none());
        let confirm = PairConfirmRequest {
            pairing_id: begun.pairing_id,
            confirm_tag: pair_crypto::b64u_encode(&tag),
            key_verification: "sas".into(),
            wifi: None,
        };
        assert_eq!(
            confirm_pair(&store, &confirm, NOW + 3).await.unwrap_err(),
            PairError::UnknownOrExpired
        );
    }
}
