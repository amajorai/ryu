//! Pairing: nonce verification + device-token issuance (PROTOCOL.md §5/§6).
//!
//! Flow: an unprovisioned device advertises `ryu-pair://<device_id>?n=<nonce>&t=<type>`
//! (QR for watch/desk, BLE characteristic for necklace). The signed-in mobile app
//! calls `POST /api/hardware/pair { device_id, pairing_nonce, device_type }`; this
//! module verifies the nonce, registers the device, and returns a per-device
//! `device_token` + `node_url`. The app then provisions the device over BLE.
//!
//! ## Trust model
//!
//! The pairing nonce is generated **on the device** at boot and shown to the user
//! out-of-band (a QR code on the watch/desk screen, or read over a local BLE GATT
//! characteristic on the necklace). Possession of the nonce is therefore the
//! proof that the app is physically near the device. The node does not pre-know
//! the nonce; it accepts the first pairing call that presents a well-formed nonce
//! for an *unpaired* device_id, registers the device, and then **burns** that
//! (device_id, nonce) pair so the same QR can't be replayed to mint a second
//! token. A device_id that is already paired is rejected (re-pair requires an
//! explicit revoke first), which prevents a stranger who later sees the QR from
//! hijacking an in-use device.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::OnceLock;

use super::protocol::{PairRequest, PairResponse};
use super::store::{hash_token, DeviceRecord, DeviceStore};

/// Why a pairing attempt was rejected (maps to an `error.code` / HTTP status).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairError {
    /// The nonce was missing/malformed (too short to be a real pairing nonce) or
    /// has already been consumed (replay).
    BadNonce,
    /// The device_id is already paired to this node.
    AlreadyPaired,
    /// Internal storage failure.
    Storage,
}

impl PairError {
    /// Stable machine code for the JSON `error.code` field / logs.
    pub fn code(self) -> &'static str {
        match self {
            PairError::BadNonce => "bad_nonce",
            PairError::AlreadyPaired => "already_paired",
            PairError::Storage => "storage",
        }
    }

    /// Human-readable message for the REST response.
    pub fn message(self) -> &'static str {
        match self {
            PairError::BadNonce => "pairing nonce missing, malformed, or already used",
            PairError::AlreadyPaired => "device already paired (revoke it first to re-pair)",
            PairError::Storage => "device registry storage error",
        }
    }
}

/// Minimum accepted nonce length. The firmware [`pairing`] component emits a
/// 128-bit nonce as hex (32 chars); we accept anything plausibly random to stay
/// tolerant of encoding, while rejecting empty/trivial values.
const MIN_NONCE_LEN: usize = 8;

/// Process-global ledger of consumed `(device_id, nonce)` pairs, so a captured QR
/// cannot be replayed within the lifetime of the node process. (A paired
/// device_id is also rejected by the store check below, so this mainly guards the
/// window between a failed insert and a retry, and double-submits.)
fn consumed_nonces() -> &'static Mutex<HashSet<String>> {
    static LEDGER: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Generate a fresh, cryptographically-random per-device Bearer token (256 bits,
/// hex-encoded). The raw token is returned to the app exactly once (in
/// [`PairResponse`]); only its hash is persisted (see [`DeviceStore`]).
pub fn generate_device_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("rht_{}", hex::encode(bytes))
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

/// Verify the pairing nonce and register the device, returning its token and the
/// node URL the device should connect to.
///
/// `node_url` is derived by the caller from the node's reachable address
/// (tailnet/LAN); the resolution seam is `sidecar::tailscale` (see
/// `server::hardware_api`).
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

    // Burn the (device_id, nonce) pair — fail if it was already consumed.
    let ledger_key = format!("{}:{nonce}", req.device_id);
    {
        let mut consumed = consumed_nonces().lock().unwrap();
        if !consumed.insert(ledger_key) {
            return Err(PairError::BadNonce);
        }
    }

    let token = generate_device_token();
    let now = chrono::Utc::now().timestamp_millis();
    let record = DeviceRecord {
        device_id: req.device_id.clone(),
        device_type: req.device_type,
        name: default_name(req.device_type),
        token_hash: hash_token(&token),
        last_seen: None,
        battery_pct: None,
        prefs: serde_json::json!({}),
        ambient_meeting_id: None,
        created_at: now,
    };

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::protocol::DeviceType;

    fn temp_store() -> DeviceStore {
        let dir = std::env::temp_dir().join(format!("ryu-hw-pair-{}", uuid::Uuid::new_v4()));
        DeviceStore::open(dir.join("hardware.db")).expect("open")
    }

    #[test]
    fn token_and_id_have_prefixes() {
        assert!(generate_device_token().starts_with("rht_"));
        assert!(generate_device_id(DeviceType::Watch).starts_with("rhw_"));
        assert!(generate_device_id(DeviceType::Necklace).starts_with("rhn_"));
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
        // The issued token verifies against the stored hash.
        assert!(store
            .verify_token("rhw_abc", &resp.device_token)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn rejects_short_nonce_and_replay_and_double_pair() {
        let store = temp_store();
        let short = PairRequest {
            device_id: "rhw_x".into(),
            pairing_nonce: "abc".into(),
            device_type: DeviceType::Watch,
        };
        assert_eq!(pair(&store, &short, "u").await.unwrap_err(), PairError::BadNonce);

        let req = PairRequest {
            device_id: "rhw_y".into(),
            pairing_nonce: "ffffffffffffffff".into(),
            device_type: DeviceType::Watch,
        };
        assert!(pair(&store, &req, "u").await.is_ok());
        // Already paired → rejected even with the same nonce.
        assert_eq!(
            pair(&store, &req, "u").await.unwrap_err(),
            PairError::AlreadyPaired
        );
    }
}
