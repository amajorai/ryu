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

#[tokio::test]
async fn a_device_pairs_through_begin_reveal_and_confirm_and_is_registered_only_by_the_press() {
    let harness = Harness::new();
    let device = Device::new("happy");

    let begin = harness.post(BEGIN, &device.begin_body()).await;
    assert_eq!(begin.status, StatusCode::OK, "{}", begin.text);
    let begun = begin.json();
    assert_eq!(begun["expires_in"], 180, "{}", begin.text);
    let begun = Begun {
        pairing_id: begun["pairing_id"].as_str().unwrap().to_owned(),
        node_pub: begun["node_pub"].as_str().unwrap().to_owned(),
        node_fingerprint: begun["node_fingerprint"].as_str().unwrap().to_owned(),
    };
    assert_eq!(begun.node_fingerprint, harness.node_fingerprint().await);
    let pending = harness.pending(&begun).await.expect("a begun pairing");
    assert_eq!(pending.state, PendingState::Begun);
    assert_eq!(pending.device_id, device.id);
    assert_eq!(pending.node_url, NODE_URL);
    assert!(
        !harness.registered(&device).await,
        "begin registers nothing"
    );

    // Reveal opens the commitment and returns the code the user compares; the
    // device derives the same transcript, code and fingerprint on its own.
    let reveal = harness.reveal(&device, &begun).await;
    assert_eq!(reveal.status, StatusCode::OK, "{}", reveal.text);
    let hash = device.transcript_hash(&begun);
    let revealed = reveal.json();
    assert_eq!(revealed["transcript_hash"], b64(&hash));
    assert_eq!(revealed["sas"], pair_crypto::sas(&hash));
    assert_eq!(revealed["sas"].as_str().unwrap().len(), 6);
    assert_eq!(
        revealed["device_fingerprint"],
        pair_crypto::fingerprint(&device.public)
    );
    assert_eq!(
        harness.pending(&begun).await.unwrap().state,
        PendingState::Revealed
    );
    assert!(
        !harness.registered(&device).await,
        "reveal alone does not register the device"
    );

    // The press: the confirm tag the device derives is accepted, the device is
    // registered at the secure level, and its credentials are only sealed.
    let wifi = json!({ "ssid": "HomeNet", "psk": "correct horse battery" });
    let confirm = harness
        .post(CONFIRM, &device.confirm_body(&begun, Some(wifi)))
        .await;
    assert_eq!(confirm.status, StatusCode::OK, "{}", confirm.text);
    assert!(
        !confirm.text.contains("correct horse battery"),
        "the Wi-Fi key is sealed, not returned: {}",
        confirm.text
    );
    let confirmed = confirm.json();
    let relay_token = confirmed["relay_token"].as_str().unwrap();
    assert!(relay_token.starts_with("rhr_"), "{relay_token}");
    assert_eq!(confirmed["device"]["device_id"], device.id);
    assert_eq!(confirmed["device"]["secure"], true);
    assert_eq!(
        confirmed["device"]["key_fingerprint"],
        pair_crypto::fingerprint(&device.public)
    );
    let sealed = pair_crypto::b64u_decode(confirmed["sealed_credentials"].as_str().unwrap())
        .expect("sealed credentials are base64url");
    assert!(
        !String::from_utf8_lossy(&sealed).contains("rht_"),
        "the device token is not readable in the sealed blob"
    );
    let credentials = pair_crypto::open_credentials(&device.keys(&begun), &hash, &sealed)
        .expect("the device opens its credentials");
    assert!(credentials.device_token.starts_with("rht_"));
    assert_eq!(credentials.node_url, NODE_URL);
    assert_eq!(credentials.wifi_ssid.as_deref(), Some("HomeNet"));
    assert_eq!(
        credentials.wifi_psk.as_deref(),
        Some("correct horse battery")
    );

    let record = harness
        .state
        .hardware
        .get(&device.id)
        .await
        .unwrap()
        .expect("the device is registered");
    assert_eq!(record.protocol_level, PROTOCOL_LEVEL_SECURE);
    assert_eq!(record.noise_pubkey, Some(b64(&device.public)));
    assert_eq!(record.key_verification.as_deref(), Some("sas"));
    assert_eq!(record.key_source.as_deref(), Some("ble"));
    assert_eq!(record.token_hash, hash_token(&credentials.device_token));
    assert_eq!(record.relay_token_hash, Some(hash_token(relay_token)));
    assert!(!record.needs_repair);
    assert!(
        harness.pending(&begun).await.is_none(),
        "the pending is spent"
    );

    // Single use: a replayed confirm or reveal finds nothing.
    let replay = harness.confirm(&device, &begun).await;
    assert_eq!(replay.status, StatusCode::NOT_FOUND, "{}", replay.text);
    assert_eq!(replay.code(), "unknown_or_expired");
    let reveal_again = harness.reveal(&device, &begun).await;
    assert_eq!(reveal_again.status, StatusCode::NOT_FOUND);

    // The paired device cannot begin again.
    let again = harness.post(BEGIN, &device.begin_body()).await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{}", again.text);
    assert_eq!(again.code(), "already_paired");
}

#[tokio::test]
async fn confirm_before_reveal_and_a_second_reveal_are_refused_and_leave_the_pairing_usable() {
    let harness = Harness::new();
    let device = Device::new("order");
    let begun = harness.begin(&device).await;

    let early = harness.confirm(&device, &begun).await;
    assert_eq!(early.status, StatusCode::CONFLICT, "{}", early.text);
    assert_eq!(early.code(), "bad_state");
    assert_eq!(
        harness.pending(&begun).await.expect("still pending").state,
        PendingState::Begun,
        "a refused confirm does not consume the pairing"
    );
    assert!(!harness.registered(&device).await);

    let revealed = harness.reveal(&device, &begun).await;
    assert_eq!(revealed.status, StatusCode::OK, "{}", revealed.text);
    let second = harness.reveal(&device, &begun).await;
    assert_eq!(second.status, StatusCode::CONFLICT, "{}", second.text);
    assert_eq!(second.code(), "bad_state");
    assert_eq!(
        harness.pending(&begun).await.expect("still pending").state,
        PendingState::Revealed,
        "a refused second reveal does not consume the pairing"
    );

    let confirmed = harness.confirm(&device, &begun).await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.text);
    assert!(harness.registered(&device).await);
}

#[tokio::test]
async fn a_cancelled_pairing_cannot_be_revealed_or_confirmed_and_cancel_is_idempotent() {
    let harness = Harness::new();
    let device = Device::new("cancel");
    let begun = harness.begin_and_reveal(&device).await;

    let cancelled = harness
        .post(
            CANCEL,
            &json!({ "pairing_id": begun.pairing_id, "reason": "user" }),
        )
        .await;
    assert_eq!(cancelled.status, StatusCode::OK, "{}", cancelled.text);
    assert_eq!(cancelled.json(), json!({ "ok": true }));
    assert!(harness.pending(&begun).await.is_none());

    let confirm = harness.confirm(&device, &begun).await;
    assert_eq!(confirm.status, StatusCode::NOT_FOUND, "{}", confirm.text);
    assert_eq!(confirm.code(), "unknown_or_expired");
    let reveal = harness.reveal(&device, &begun).await;
    assert_eq!(reveal.status, StatusCode::NOT_FOUND, "{}", reveal.text);
    assert!(!harness.registered(&device).await);

    // A second cancel, an unknown id and a mismatch report all answer ok.
    for body in [
        json!({ "pairing_id": begun.pairing_id }),
        json!({ "pairing_id": "never-begun" }),
        json!({ "pairing_id": b64(&[9u8; 16]), "reason": "mismatch" }),
    ] {
        let reply = harness.post(CANCEL, &body).await;
        assert_eq!(reply.status, StatusCode::OK, "{body}: {}", reply.text);
        assert_eq!(reply.json(), json!({ "ok": true }));
    }

    // A mismatch report drops a live pairing as well.
    let other = Device::new("mismatch");
    let live = harness.begin_and_reveal(&other).await;
    let mismatch = harness
        .post(
            CANCEL,
            &json!({ "pairing_id": live.pairing_id, "reason": "mismatch" }),
        )
        .await;
    assert_eq!(mismatch.status, StatusCode::OK);
    assert!(harness.pending(&live).await.is_none());
    assert_eq!(
        harness.confirm(&other, &live).await.status,
        StatusCode::NOT_FOUND
    );
    assert!(!harness.registered(&other).await);
}

#[tokio::test]
async fn an_expired_pairing_is_unknown_to_reveal_confirm_and_cancel() {
    let harness = Harness::new();
    let begin_device = Device::new("expired-begun");
    let reveal_device = Device::new("expired-revealed");
    let now = now_ms();
    let node_pub = harness
        .state
        .hardware
        .node_identity()
        .await
        .unwrap()
        .public();
    let seed = |device: &Device, marker: u8, state: PendingState| {
        let revealed = state == PendingState::Revealed;
        let pairing_id = [marker; 16];
        let begun = Begun {
            pairing_id: b64(&pairing_id),
            node_pub: b64(&node_pub),
            node_fingerprint: String::new(),
        };
        let transcript = revealed.then(|| b64(&device.transcript_hash(&begun)));
        (
            PendingPairing {
                pairing_id: begun.pairing_id.clone(),
                device_id: device.id.clone(),
                device_type: DeviceType::Necklace,
                pairing_nonce: device.nonce.clone(),
                device_pub: b64(&device.public),
                device_commit: b64(&pair_crypto::commit(&device.public, &device.rand)),
                key_source: "ble".into(),
                node_url: NODE_URL.into(),
                device_rand: revealed.then(|| b64(&device.rand)),
                transcript_hash: transcript,
                state,
                created_at: now - 200_000,
                // Expired one second ago.
                expires_at: now - 1_000,
            },
            begun,
        )
    };
    let (begun_row, begun) = seed(&begin_device, 1, PendingState::Begun);
    let (revealed_row, revealed) = seed(&reveal_device, 2, PendingState::Revealed);
    for row in [&begun_row, &revealed_row] {
        harness
            .state
            .hardware
            .insert_pending_pairing(row, now - 300_000)
            .await
            .unwrap();
    }

    let reveal = harness.reveal(&begin_device, &begun).await;
    assert_eq!(reveal.status, StatusCode::NOT_FOUND, "{}", reveal.text);
    assert_eq!(reveal.code(), "unknown_or_expired");
    let confirm = harness.confirm(&reveal_device, &revealed).await;
    assert_eq!(confirm.status, StatusCode::NOT_FOUND, "{}", confirm.text);
    assert_eq!(confirm.code(), "unknown_or_expired");
    assert!(!harness.registered(&reveal_device).await);
    assert!(!harness.registered(&begin_device).await);
    let cancel = harness
        .post(CANCEL, &json!({ "pairing_id": revealed.pairing_id }))
        .await;
    assert_eq!(cancel.status, StatusCode::OK, "{}", cancel.text);

    // The same rows, unexpired, would have been accepted: expiry is the only
    // reason the refusals above happened.
    let live = Device::new("not-expired");
    let live_begun = harness.begin_and_reveal(&live).await;
    assert_eq!(
        harness.confirm(&live, &live_begun).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_wrong_reveal_or_a_wrong_confirm_tag_burns_the_attempt_and_registers_nothing() {
    let harness = Harness::new();

    let committed = Device::new("bad-reveal");
    let begun = harness.begin(&committed).await;
    let wrong = harness
        .post(
            REVEAL,
            &json!({ "pairing_id": begun.pairing_id, "device_rand": b64(&[0xAB; 16]) }),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED, "{}", wrong.text);
    assert_eq!(wrong.code(), "commitment_mismatch");
    assert!(
        harness.pending(&begun).await.is_none(),
        "the attempt is burned"
    );
    let retry = harness.reveal(&committed, &begun).await;
    assert_eq!(retry.status, StatusCode::NOT_FOUND, "{}", retry.text);

    let pressed = Device::new("bad-tag");
    let begun = harness.begin_and_reveal(&pressed).await;
    let wrong_tag = harness
        .post(
            CONFIRM,
            &json!({
                "pairing_id": begun.pairing_id,
                "confirm_tag": b64(&[0u8; 32]),
                "key_verification": "sas",
            }),
        )
        .await;
    assert_eq!(
        wrong_tag.status,
        StatusCode::UNAUTHORIZED,
        "{}",
        wrong_tag.text
    );
    assert_eq!(wrong_tag.code(), "confirmation_mismatch");
    assert!(!harness.registered(&pressed).await);
    assert!(
        harness.pending(&begun).await.is_none(),
        "the attempt is burned"
    );
    let retry = harness.confirm(&pressed, &begun).await;
    assert_eq!(retry.status, StatusCode::NOT_FOUND, "{}", retry.text);
    assert!(!harness.registered(&pressed).await);
}

#[tokio::test]
async fn malformed_bodies_are_a_bad_request_that_does_not_echo_the_body() {
    let harness = Harness::new();
    for uri in [BEGIN, REVEAL, CONFIRM, CANCEL] {
        for body in ["{ not json: secret-marker", "{}", "[]", "\"secret-marker\""] {
            let reply = harness.post_raw(uri, body).await;
            assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{uri} {body}");
            assert_eq!(reply.code(), "bad_request", "{uri} {body}");
            assert!(
                !reply.text.contains("secret-marker"),
                "{uri}: the rejection echoed the body: {}",
                reply.text
            );
        }
    }

    // Well-formed JSON with a field the protocol refuses.
    let device = Device::new("fields");
    let refused = |field: &'static str, value: Value| {
        let mut body = device.begin_body();
        body[field] = value;
        body
    };
    for (label, body) in [
        (
            "a nonce that is not lowercase hex",
            refused("pairing_nonce", json!("ABCDEF0123456789ABCDEF0123456789")),
        ),
        ("a short nonce", refused("pairing_nonce", json!("abc123"))),
        (
            "an unknown device type",
            refused("device_type", json!("toaster")),
        ),
        ("an unknown key source", refused("key_source", json!("nfc"))),
        ("an unknown policy", refused("policy", json!("tap_only"))),
        (
            "a device key of the wrong length",
            refused("device_pub", json!(b64(&[1u8; 16]))),
        ),
        (
            "a device id with a slash",
            refused("device_id", json!("rhn/evil")),
        ),
    ] {
        let reply = harness.post(BEGIN, &body).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{label}: {}",
            reply.text
        );
        assert_eq!(reply.code(), "bad_request", "{label}");
    }
    assert!(!harness.registered(&device).await);

    // A confirm that names an unknown verification method, or a pairing id that
    // is not 16 bytes, is refused before it can consume anything.
    let pressed = Device::new("verification");
    let begun = harness.begin_and_reveal(&pressed).await;
    let mut maybe = pressed.confirm_body(&begun, None);
    maybe["key_verification"] = json!("maybe");
    let maybe = harness.post(CONFIRM, &maybe).await;
    assert_eq!(maybe.status, StatusCode::BAD_REQUEST, "{}", maybe.text);
    let mut short = pressed.confirm_body(&begun, None);
    short["pairing_id"] = json!("short");
    let short = harness.post(CONFIRM, &short).await;
    assert_eq!(short.status, StatusCode::BAD_REQUEST, "{}", short.text);
    assert_eq!(
        harness.pending(&begun).await.expect("untouched").state,
        PendingState::Revealed
    );
}

#[tokio::test]
async fn begin_refuses_a_key_bound_elsewhere_a_full_node_and_a_node_without_an_identity() {
    let harness = Harness::new();

    // A key bound to another device is refused for a new device id.
    let first = Device::new("bound");
    let begun = harness.begin_and_reveal(&first).await;
    assert_eq!(harness.confirm(&first, &begun).await.status, StatusCode::OK);
    let mut clone = Device::new("clone");
    clone.secret = first.secret;
    clone.public = first.public;
    let clone_reply = harness.post(BEGIN, &clone.begin_body()).await;
    assert_eq!(
        clone_reply.status,
        StatusCode::CONFLICT,
        "{}",
        clone_reply.text
    );
    assert_eq!(clone_reply.code(), "already_paired");

    // At most four pairings are pending; the fifth is told to wait.
    let crowded = Harness::new();
    for index in 0..4 {
        crowded.begin(&Device::new(&format!("crowd{index}"))).await;
    }
    let overflow = crowded
        .post(BEGIN, &Device::new("crowd-extra").begin_body())
        .await;
    assert_eq!(
        overflow.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        overflow.text
    );
    assert_eq!(overflow.code(), "too_many_pending");

    // Without a sealed node key there is no identity to pair against.
    let unsealed = Harness::without_identity();
    let device = Device::new("no-identity");
    let reply = unsealed.post(BEGIN, &device.begin_body()).await;
    assert_eq!(
        reply.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        reply.text
    );
    assert_eq!(reply.code(), "node_identity_unavailable");
    assert!(!unsealed.registered(&device).await);
}

#[tokio::test]
async fn legacy_pairing_is_a_426_once_the_node_preference_turns_it_off_and_registers_nothing() {
    let harness = Harness::new();
    let legacy = |device_id: &str, nonce: &str| json!({ "device_id": device_id, "pairing_nonce": nonce, "device_type": "watch" });

    // On by default: a legacy device registers at the legacy level.
    let open = harness
        .post(LEGACY, &legacy("rhw_legacy_open", "0123456789abcdef"))
        .await;
    assert_eq!(open.status, StatusCode::OK, "{}", open.text);
    let opened = open.json();
    assert!(opened["device_token"].as_str().unwrap().starts_with("rht_"));
    assert_eq!(opened["node_url"], NODE_URL);
    let record = harness
        .state
        .hardware
        .get("rhw_legacy_open")
        .await
        .unwrap()
        .expect("registered");
    assert_eq!(record.protocol_level, PROTOCOL_LEVEL_LEGACY);
    assert_eq!(record.noise_pubkey, None);
    let replay = harness
        .post(LEGACY, &legacy("rhw_legacy_open", "0123456789abcdef"))
        .await;
    assert_eq!(replay.status, StatusCode::CONFLICT, "{}", replay.text);
    assert_eq!(replay.code(), "already_paired");

    // Off: 426 with the v2-required code, no device and no spent nonce.
    for off in ["false", " False "] {
        harness
            .state
            .preferences
            .set(hardware_public::LEGACY_PAIRING_PREF, off)
            .await
            .unwrap();
        let refused = harness
            .post(LEGACY, &legacy("rhw_legacy_off", "fedcba9876543210"))
            .await;
        assert_eq!(
            refused.status,
            StatusCode::UPGRADE_REQUIRED,
            "{off:?}: {}",
            refused.text
        );
        assert_eq!(refused.code(), "pairing_v2_required");
        assert!(
            !harness
                .state
                .hardware
                .get("rhw_legacy_off")
                .await
                .unwrap()
                .is_some(),
            "{off:?}: the refused legacy pairing registered a device"
        );
        assert!(
            !harness
                .state
                .hardware
                .nonce_consumed("rhw_legacy_off", "fedcba9876543210")
                .await
                .unwrap(),
            "{off:?}: the refused legacy pairing spent its nonce"
        );
    }

    // Pairing v2 is unaffected by the preference.
    let device = Device::new("while-legacy-off");
    let begun = harness.begin_and_reveal(&device).await;
    assert_eq!(
        harness.confirm(&device, &begun).await.status,
        StatusCode::OK
    );

    // Anything but "false" turns it back on.
    harness
        .state
        .preferences
        .set(hardware_public::LEGACY_PAIRING_PREF, "true")
        .await
        .unwrap();
    let back = harness
        .post(LEGACY, &legacy("rhw_legacy_off", "fedcba9876543210"))
        .await;
    assert_eq!(back.status, StatusCode::OK, "{}", back.text);
}

#[tokio::test]
async fn every_pairing_route_needs_the_node_bearer_and_a_refusal_changes_nothing() {
    let harness = Harness::new();
    let fingerprint = harness.node_fingerprint().await;
    let device = Device::new("unauthorized");
    let begun = harness.begin_and_reveal(&device).await;
    let credentials: [(&str, Option<&str>); 3] = [
        ("no bearer", None),
        ("a wrong bearer", Some("not-the-node-token")),
        (
            "the node token with another case",
            Some("HARDWARE-PAIRING-ROUTES-NODE-TOKEN"),
        ),
    ];
    for (label, bearer) in credentials {
        let calls = [
            (
                LEGACY,
                json!({ "device_id": "rhw_unauth", "pairing_nonce": "0123456789abcdef", "device_type": "watch" }),
            ),
            (BEGIN, Device::new("unauth-begin").begin_body()),
            (
                REVEAL,
                json!({ "pairing_id": begun.pairing_id, "device_rand": b64(&device.rand) }),
            ),
            (CONFIRM, device.confirm_body(&begun, None)),
            (CANCEL, json!({ "pairing_id": begun.pairing_id })),
            (RESET, json!({})),
        ];
        for (uri, body) in calls {
            let reply = harness.send(uri, Some(body.to_string()), bearer).await;
            assert_eq!(
                reply.status,
                StatusCode::UNAUTHORIZED,
                "{label}: {uri}: {}",
                reply.text
            );
        }
    }
    // Nothing happened: the legacy device was not registered, the revealed
    // pairing was neither confirmed nor cancelled, the node key is the same,
    // and the refused begins took none of the four pending slots.
    assert!(harness
        .state
        .hardware
        .get("rhw_unauth")
        .await
        .unwrap()
        .is_none());
    assert!(!harness.registered(&device).await);
    assert_eq!(
        harness.pending(&begun).await.expect("untouched").state,
        PendingState::Revealed
    );
    assert_eq!(harness.node_fingerprint().await, fingerprint);
    for index in 0..3 {
        harness.begin(&Device::new(&format!("slot{index}"))).await;
    }
    // Three more fit beside the revealed one; a fifth would not.
    let overflow = harness
        .post(BEGIN, &Device::new("slot-overflow").begin_body())
        .await;
    assert_eq!(
        overflow.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        overflow.text
    );

    // The bearer is what admits the same calls.
    assert_eq!(
        harness.confirm(&device, &begun).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn identity_reset_flags_secure_devices_and_drops_pairings_started_under_the_old_key() {
    let harness = Harness::new();
    let secure = Device::new("secure");
    let begun = harness.begin_and_reveal(&secure).await;
    assert_eq!(
        harness.confirm(&secure, &begun).await.status,
        StatusCode::OK
    );
    let legacy = harness
        .post(
            LEGACY,
            &json!({ "device_id": "rhw_reset_legacy", "pairing_nonce": "0123456789abcdef", "device_type": "watch" }),
        )
        .await;
    assert_eq!(legacy.status, StatusCode::OK, "{}", legacy.text);
    let stale = Device::new("stale");
    let stale_begun = harness.begin_and_reveal(&stale).await;
    assert_eq!(stale_begun.node_fingerprint, begun.node_fingerprint);

    let reset = harness.post(RESET, &json!({})).await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text);
    let reset = reset.json();
    assert_ne!(reset["node_fingerprint"], json!(begun.node_fingerprint));
    assert_eq!(
        reset["node_fingerprint"],
        json!(harness.node_fingerprint().await)
    );
    assert_eq!(
        reset["devices_needing_repair"],
        json!([secure.id]),
        "only the key-pinned device must re-pair: {reset}"
    );
    assert!(
        harness
            .state
            .hardware
            .get(&secure.id)
            .await
            .unwrap()
            .unwrap()
            .needs_repair
    );
    assert!(
        !harness
            .state
            .hardware
            .get("rhw_reset_legacy")
            .await
            .unwrap()
            .unwrap()
            .needs_repair
    );

    // Reset drops every pending pairing, because each one is bound to the old
    // node key: the pairing that was revealed under it can neither be
    // confirmed nor revealed again, and nothing is registered.
    assert!(harness.pending(&stale_begun).await.is_none());
    let late = harness.confirm(&stale, &stale_begun).await;
    assert_eq!(late.status, StatusCode::NOT_FOUND, "{}", late.text);
    assert_eq!(late.code(), "unknown_or_expired");
    let late_reveal = harness.reveal(&stale, &stale_begun).await;
    assert_eq!(
        late_reveal.status,
        StatusCode::NOT_FOUND,
        "{}",
        late_reveal.text
    );
    assert!(!harness.registered(&stale).await);

    // A new pairing runs against the new key.
    let fresh = Device::new("fresh");
    let fresh_begun = harness.begin_and_reveal(&fresh).await;
    assert_ne!(fresh_begun.node_pub, begun.node_pub);
    assert_eq!(
        harness.confirm(&fresh, &fresh_begun).await.status,
        StatusCode::OK
    );

    // Without a sealed node key the reset is refused and nothing changes.
    let unsealed = Harness::without_identity();
    let refused = unsealed.post(RESET, &json!({})).await;
    assert_eq!(
        refused.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        refused.text
    );
    assert_eq!(refused.code(), "node_identity_unavailable");
}

/// The tests above mount `hardware_public`'s handlers on a router of their
/// own, so this pins the production registration: each handler is mounted
/// once, on the protected router (behind the node bearer), at its path.
#[test]
fn the_pairing_handlers_are_mounted_once_on_the_protected_router_at_their_paths() {
    let source = include_str!("mod.rs");
    let protected = source
        .find("let protected = Router::new()")
        .expect("the protected router");
    for (path, handler) in [
        (LEGACY, "pair_device"),
        (BEGIN, "pair_begin"),
        (REVEAL, "pair_reveal"),
        (CONFIRM, "pair_confirm"),
        (CANCEL, "pair_cancel"),
        (RESET, "hardware_identity_reset"),
    ] {
        let needle = format!("post(hardware_public::{handler})");
        assert_eq!(
            source.matches(&needle).count(),
            1,
            "{handler} is mounted once"
        );
        let at = source.find(&needle).unwrap();
        assert!(
            at > protected,
            "{handler} is registered before the protected router starts"
        );
        let route = source[..at].rfind(".route(").expect("a route registration");
        assert!(
            source[route..at].contains(&format!("\"{path}\"")),
            "{handler} is not registered at {path}"
        );
    }
}
