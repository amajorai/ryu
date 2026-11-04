//! Core's hardware pairing routes, driven through the shipping handlers behind
//! the shipping node-bearer gate.
//!
//! `POST /api/hardware/pair/{begin,reveal,confirm,cancel}` (pairing v2), the
//! legacy `POST /api/hardware/pair` 426 gate and `POST
//! /api/hardware/identity/reset` are mounted with `hardware_public`'s own
//! handlers behind `require_auth_with_token`. The device is simulated with the
//! crate's public pairing crypto, so the happy path is real: the node's SAS and
//! transcript are recomputed on the device side, the confirm tag is derived
//! from the X25519 agreement with the node key, and the sealed credentials are
//! opened with the keys the device derives. Durable effects are read back from
//! the device store the handlers wrote to.
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::{middleware, Router};
use ryu_hardware::identity::PlaintextSealerForTests;
use ryu_hardware::pair_crypto::{self, TranscriptInputs};
use ryu_hardware::protocol::DeviceType;
use ryu_hardware::store::{
    hash_token, PendingPairing, PendingState, PROTOCOL_LEVEL_LEGACY, PROTOCOL_LEVEL_SECURE,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::{
    hardware_public, isolated_plugin_hook_test_state, require_auth_with_token, ServerState,
};

const NODE_TOKEN: &str = "hardware-pairing-routes-node-token";
const HOST: &str = "127.0.0.1:7980";
const NODE_URL: &str = "ws://127.0.0.1:7980/api/hardware/ws";
const BEGIN: &str = "/api/hardware/pair/begin";
const REVEAL: &str = "/api/hardware/pair/reveal";
const CONFIRM: &str = "/api/hardware/pair/confirm";
const CANCEL: &str = "/api/hardware/pair/cancel";
const LEGACY: &str = "/api/hardware/pair";
const RESET: &str = "/api/hardware/identity/reset";

struct Reply {
    status: StatusCode,
    text: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or_else(|error| {
            panic!("{} body is not JSON ({error}): {}", self.status, self.text)
        })
    }

    /// The `{"error":{"code","message"}}` code of a refusal.
    fn code(&self) -> String {
        let body = self.json();
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty()),
            "a refusal carries a message: {}",
            self.text
        );
        body["error"]["code"]
            .as_str()
            .unwrap_or_else(|| panic!("no error code in {}", self.text))
            .to_owned()
    }
}

struct Harness {
    _directory: tempfile::TempDir,
    state: ServerState,
    router: Router,
}

impl Harness {
    fn new() -> Self {
        Self::build(true)
    }

    /// A node whose key sealer is not installed, so it has no identity.
    fn without_identity() -> Self {
        Self::build(false)
    }

    fn build(sealed_identity: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = isolated_plugin_hook_test_state(directory.path());
        if sealed_identity {
            state
                .hardware
                .set_key_sealer(Arc::new(PlaintextSealerForTests));
        }
        let router = Router::new()
            .route(LEGACY, post(hardware_public::pair_device))
            .route(BEGIN, post(hardware_public::pair_begin))
            .route(REVEAL, post(hardware_public::pair_reveal))
            .route(CONFIRM, post(hardware_public::pair_confirm))
            .route(CANCEL, post(hardware_public::pair_cancel))
            .route(RESET, post(hardware_public::hardware_identity_reset))
            .layer(middleware::from_fn(move |request, next| async move {
                require_auth_with_token(request, next, Some(NODE_TOKEN.to_owned())).await
            }))
            .with_state(state.clone());
        Self {
            _directory: directory,
            state,
            router,
        }
    }

    async fn send(&self, uri: &str, body: Option<String>, bearer: Option<&str>) -> Reply {
        let mut request = Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", HOST);
        if let Some(bearer) = bearer {
            request = request.header("authorization", format!("Bearer {bearer}"));
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body)),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        Reply {
            status,
            text: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    /// An authorized call with a JSON body.
    async fn post(&self, uri: &str, body: &Value) -> Reply {
        self.send(uri, Some(body.to_string()), Some(NODE_TOKEN))
            .await
    }

    async fn post_raw(&self, uri: &str, body: &str) -> Reply {
        self.send(uri, Some(body.to_owned()), Some(NODE_TOKEN))
            .await
    }

    async fn begin(&self, device: &Device) -> Begun {
        let reply = self.post(BEGIN, &device.begin_body()).await;
        assert_eq!(reply.status, StatusCode::OK, "begin: {}", reply.text);
        let body = reply.json();
        Begun {
            pairing_id: body["pairing_id"].as_str().unwrap().to_owned(),
            node_pub: body["node_pub"].as_str().unwrap().to_owned(),
            node_fingerprint: body["node_fingerprint"].as_str().unwrap().to_owned(),
        }
    }

    async fn reveal(&self, device: &Device, begun: &Begun) -> Reply {
        self.post(
            REVEAL,
            &json!({ "pairing_id": begun.pairing_id, "device_rand": b64(&device.rand) }),
        )
        .await
    }

    async fn confirm(&self, device: &Device, begun: &Begun) -> Reply {
        self.post(CONFIRM, &device.confirm_body(begun, None)).await
    }

    /// Begin and reveal, leaving the pairing waiting for the press.
    async fn begin_and_reveal(&self, device: &Device) -> Begun {
        let begun = self.begin(device).await;
        let revealed = self.reveal(device, &begun).await;
        assert_eq!(revealed.status, StatusCode::OK, "reveal: {}", revealed.text);
        begun
    }

    async fn pending(&self, begun: &Begun) -> Option<PendingPairing> {
        self.state
            .hardware
            .get_pending_pairing(&begun.pairing_id, now_ms())
            .await
            .unwrap()
    }

    async fn registered(&self, device: &Device) -> bool {
        self.state.hardware.get(&device.id).await.unwrap().is_some()
    }

    async fn node_fingerprint(&self) -> String {
        self.state
            .hardware
            .node_identity()
            .await
            .unwrap()
            .fingerprint()
    }
}

struct Begun {
    pairing_id: String,
    node_pub: String,
    node_fingerprint: String,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn b64(bytes: &[u8]) -> String {
    pair_crypto::b64u_encode(bytes)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    let mut filled = 0;
    while filled < N {
        let id = uuid::Uuid::new_v4();
        let take = (N - filled).min(16);
        out[filled..filled + take].copy_from_slice(&id.as_bytes()[..take]);
        filled += take;
    }
    out
}

/// A device with its own static key, commitment value and pairing nonce.
struct Device {
    id: String,
    secret: [u8; 32],
    public: [u8; 32],
    rand: [u8; 16],
    nonce: String,
}

impl Device {
    fn new(label: &str) -> Self {
        let secret = random_bytes::<32>();
        Self {
            id: format!(
                "rhn_{label}_{}",
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            ),
            public: pair_crypto::public_key(&secret),
            secret,
            rand: random_bytes::<16>(),
            nonce: uuid::Uuid::new_v4().simple().to_string(),
        }
    }

    fn begin_body(&self) -> Value {
        json!({
            "device_id": self.id,
            "device_type": "necklace",
            "pairing_nonce": self.nonce,
            "device_pub": b64(&self.public),
            "device_commit": b64(&pair_crypto::commit(&self.public, &self.rand)),
            "key_source": "ble",
            "policy": "sas_press",
        })
    }

    /// The transcript hash as the device computes it from what it was told.
    fn transcript_hash(&self, begun: &Begun) -> [u8; 32] {
        let pairing_id = pair_crypto::b64u_decode_array::<16>(&begun.pairing_id).unwrap();
        let node_pub = pair_crypto::b64u_decode_array::<32>(&begun.node_pub).unwrap();
        pair_crypto::transcript_hash(&pair_crypto::transcript(&TranscriptInputs {
            device_id: &self.id,
            device_type: "necklace",
            pairing_nonce: &self.nonce,
            pairing_id: &pairing_id,
            device_pub: &self.public,
            node_pub: &node_pub,
            device_rand: &self.rand,
        }))
    }

    fn keys(&self, begun: &Begun) -> pair_crypto::PairKeys {
        let node_pub = pair_crypto::b64u_decode_array::<32>(&begun.node_pub).unwrap();
        let dh = pair_crypto::dh(&self.secret, &node_pub).expect("a usable node key");
        pair_crypto::derive(&dh, &self.transcript_hash(begun))
    }

    fn confirm_body(&self, begun: &Begun, wifi: Option<Value>) -> Value {
        let tag = pair_crypto::confirm_tag(&self.keys(begun));
        let mut body = json!({
            "pairing_id": begun.pairing_id,
            "confirm_tag": b64(&tag),
            "key_verification": "sas",
        });
        if let Some(wifi) = wifi {
            body["wifi"] = wifi;
        }
        body
    }
}

#[path = "hardware_pairing_routes_test/node_pairing_test.rs"]
mod node_pairing;
#[path = "hardware_pairing_routes_test/reveal_confirm_test.rs"]
mod reveal_confirm;
