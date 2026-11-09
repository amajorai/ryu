//! Device identity: principals, the signed envelope and replay protection.
//!
//! A device is a non-exportable P-256 key (Secure Enclave / Android Keystore)
//! registered against `(principal_id, device_id)`. Every device-lane request
//! carries `X-Ryu-Client-Id`, `X-Ryu-Device-Ts` and `X-Ryu-Device-Sig`, an
//! ECDSA P-256 / SHA-256 signature over [`canonical_string`]. Timestamps must
//! be within ±120 s and a signature is accepted once per device in five
//! minutes. The replay key is the signature's canonical form (low-S `r‖s`),
//! never the header text, so re-encoding one signature (DER vs raw, another
//! base64 alphabet, or its high-S twin) is still a replay; the HTTP layer also
//! persists accepted keys in `device_tools.db` so a restart does not reopen the
//! window. `X-Ryu-Client-Id` alone is a routing key, never an identity.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::pkcs8::DecodePublicKey as _;
use sha2::{Digest, Sha256};

pub(crate) const CLIENT_ID_HEADER: &str = "x-ryu-client-id";
pub(crate) const TS_HEADER: &str = "x-ryu-device-ts";
pub(crate) const SIG_HEADER: &str = "x-ryu-device-sig";
/// First line of every canonical string; bump to version the scheme.
pub(crate) const SIG_SCHEME: &str = "ryu-device-v1";
pub(crate) const MAX_SKEW_MS: i64 = 120_000;
const REPLAY_TTL_MS: i64 = 300_000;

/// Who owns a device row, a device call and a grant.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum DevicePrincipal {
    /// A verified cloud user (JWT), on any node.
    User(String),
    /// The owner of an unbound personal node authenticating with the node
    /// token and no user JWT. Pairing as this principal needs host approval.
    LocalOwner,
}

impl DevicePrincipal {
    /// The stable id used in rows, frames and the canonical string.
    pub(crate) fn id(&self) -> String {
        match self {
            Self::User(user_id) => format!("user:{user_id}"),
            Self::LocalOwner => "owner:local".to_owned(),
        }
    }

    /// Whether a conversation stored with `owner_user_id` belongs to this
    /// principal. Never true for `None == None` on a user principal; the local
    /// owner owns unowned conversations on an unbound node only.
    pub(crate) fn owns_conversation(&self, owner_user_id: Option<&str>, node_bound: bool) -> bool {
        match self {
            Self::User(user_id) => owner_user_id == Some(user_id.as_str()),
            Self::LocalOwner => !node_bound && owner_user_id.is_none(),
        }
    }
}

/// `ryu-device-v1\n<METHOD>\n<route>\n<principal_id>\n<device_id>\n<ts_ms>\n<hex sha256(body)>`.
///
/// `route` is the route template the handler serves (for example
/// `/api/device-tools/claim`), never the raw URI, so a relay that adds a
/// prefix does not break verification. GET bodies hash the empty string.
pub(crate) fn canonical_string(
    method: &str,
    route: &str,
    principal_id: &str,
    device_id: &str,
    timestamp_ms: i64,
    body: &[u8],
) -> String {
    format!(
        "{SIG_SCHEME}\n{}\n{route}\n{principal_id}\n{device_id}\n{timestamp_ms}\n{}",
        method.to_ascii_uppercase(),
        hex::encode(Sha256::digest(body))
    )
}

fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(text))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(text))
        .ok()
}

/// Decode and check a base64 DER SubjectPublicKeyInfo for a P-256 key.
pub(crate) fn decode_public_key(spki_b64: &str) -> Option<Vec<u8>> {
    let der = b64_decode(spki_b64)?;
    if der.len() > 512 {
        return None;
    }
    p256::ecdsa::VerifyingKey::from_public_key_der(&der).ok()?;
    Some(der)
}

/// Parse a base64 ECDSA P-256 signature: DER, as Security.framework and
/// Keystore produce, or raw 64-byte r‖s, as WebCrypto produces.
fn parse_signature(sig_b64: &str) -> Option<p256::ecdsa::Signature> {
    let raw = b64_decode(sig_b64)?;
    p256::ecdsa::Signature::from_der(&raw)
        .ok()
        .or_else(|| p256::ecdsa::Signature::from_slice(&raw).ok())
}

/// The encoding-independent replay key of a signature: hex of its low-S
/// `r‖s` bytes. Every encoding of the same signature, and its high-S twin
/// `(r, n-s)` (which p256 also accepts), maps to the same key. High-S itself
/// is not refused: Secure Enclave and Keystore do not normalize S.
pub(crate) fn replay_key(sig_b64: &str) -> Option<String> {
    let signature = parse_signature(sig_b64)?;
    let canonical = signature.normalize_s();
    Some(hex::encode(canonical.to_bytes()))
}

/// Verify a base64 ECDSA P-256 signature (DER or raw r‖s).
pub(crate) fn verify_signature(spki_der: &[u8], message: &[u8], sig_b64: &str) -> bool {
    let Ok(key) = p256::ecdsa::VerifyingKey::from_public_key_der(spki_der) else {
        return false;
    };
    parse_signature(sig_b64).is_some_and(|sig| key.verify(message, &sig).is_ok())
}

/// Whether `timestamp_ms` is within the allowed skew of `now_ms`.
pub(crate) fn timestamp_fresh(timestamp_ms: i64, now_ms: i64) -> bool {
    (timestamp_ms - now_ms).abs() <= MAX_SKEW_MS
}

fn replay_cache() -> &'static Mutex<HashMap<(String, String), i64>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), i64>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record `(device_id, replay_key)`; `false` when it was already seen
/// (replay) or the cache is unavailable (fail closed). `replay_key` must come
/// from [`replay_key`], never from the raw header.
pub(crate) fn remember_signature(device_id: &str, replay_key: &str, now_ms: i64) -> bool {
    let Ok(mut cache) = replay_cache().lock() else {
        return false;
    };
    cache.retain(|_, expires| *expires > now_ms);
    let key = (device_id.to_owned(), replay_key.to_owned());
    if cache.contains_key(&key) {
        return false;
    }
    cache.insert(key, now_ms + REPLAY_TTL_MS);
    true
}

/// The headers of a signed device-lane request.
#[derive(Clone, Debug)]
pub(crate) struct SignedHeaders {
    pub(crate) device_id: String,
    pub(crate) timestamp_ms: i64,
    pub(crate) signature: String,
}

/// Why a signed request was refused. All map to 401 `invalid_signature`
/// except `NotPaired` (403 `device_not_paired`) and `Mismatch` (400).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SignatureError {
    Missing,
    Stale,
    Replayed,
    BadSignature,
    NotPaired,
    Mismatch,
}

/// How long an accepted replay key must stay remembered.
pub(crate) const REPLAY_WINDOW_MS: i64 = REPLAY_TTL_MS;

/// Verify one signed request against the stored key of an active device and
/// return its replay key, which the caller persists through
/// `DeviceToolStore::accept_signature` (the in-process cache alone does not
/// survive a restart).
#[allow(clippy::too_many_arguments)]
pub(crate) fn verify_request(
    headers: &SignedHeaders,
    method: &str,
    route: &str,
    principal_id: &str,
    stored_key: Option<&[u8]>,
    body: &[u8],
    now_ms: i64,
) -> Result<String, SignatureError> {
    if headers.signature.trim().is_empty() || headers.device_id.trim().is_empty() {
        return Err(SignatureError::Missing);
    }
    if !timestamp_fresh(headers.timestamp_ms, now_ms) {
        return Err(SignatureError::Stale);
    }
    let Some(key) = stored_key else {
        return Err(SignatureError::NotPaired);
    };
    let message = canonical_string(
        method,
        route,
        principal_id,
        &headers.device_id,
        headers.timestamp_ms,
        body,
    );
    if !verify_signature(key, message.as_bytes(), &headers.signature) {
        return Err(SignatureError::BadSignature);
    }
    // Checked after the signature so an unauthenticated caller cannot burn
    // a legitimate signature's slot.
    let Some(key) = replay_key(&headers.signature) else {
        return Err(SignatureError::BadSignature);
    };
    if !remember_signature(&headers.device_id, &key, now_ms) {
        return Err(SignatureError::Replayed);
    }
    Ok(key)
}
