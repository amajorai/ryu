//! Home (P6): the signed accessory cache decides the security class, and a
//! security action is approved only on the target phone with its
//! user-presence key.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::approvals::policy::ApprovalMode;

use super::claims::{self, ClaimPhase, ClaimRequest, ResultSubmission};
use super::confirm::{confirm_message, verify_confirmation, ConfirmError, Confirmation};
use super::declaration::ClientDeviceDecl;
use super::dispatch::dispatch_call;
use super::frames::DeviceUiEvent;
use super::home::{self, classify, normalize_service, parse_accessories, HomeAccessory};
use super::identity::DevicePrincipal;
use super::identity_tests::{sign_b64, test_key};
use super::offer::DeviceOffer;
use super::prompts::{self, PromptAnswer, ResolveError};
use super::registry::{store, DeviceState, NewDevice};
use super::{now_ms, presence};

#[test]
fn service_types_normalize_and_posts_are_bounded() {
    assert_eq!(
        normalize_service("HMServiceTypeLockMechanism"),
        "lockmechanism"
    );
    assert_eq!(normalize_service("lock_mechanism"), "lockmechanism");
    assert_eq!(normalize_service("Lightbulb"), "lightbulb");
    let parsed = parse_accessories(&json!([
        { "accessory_id": " a1 ", "name": "Front\u{7}door", "services": ["LockMechanism", "lock_mechanism"] },
        { "accessory_id": "a2", "services": [] },
    ]))
    .unwrap();
    assert_eq!(
        parsed[0],
        HomeAccessory {
            id: "a1".into(),
            name: "Frontdoor".into(),
            services: vec!["lockmechanism".into()],
        }
    );
    assert_eq!(parsed[1].name, "");
    assert!(parse_accessories(&json!([{ "accessory_id": "", "services": [] }])).is_none());
    assert!(parse_accessories(&json!([{ "name": "no id", "services": [] }])).is_none());
    let too_many: Vec<Value> = (0..=home::MAX_ACCESSORIES)
        .map(|i| json!({ "accessory_id": format!("a{i}"), "services": [] }))
        .collect();
    assert!(parse_accessories(&Value::Array(too_many)).is_none());
}

#[test]
fn unknown_stale_and_physical_access_accessories_are_security_class() {
    let store = super::registry::DeviceToolStore::open_in_memory().unwrap();
    let now = 1_800_000_000_000;
    store
        .replace_home_accessories(
            "user:u1",
            "dev-1",
            &parse_accessories(&json!([
                { "accessory_id": "lamp", "name": "Desk lamp", "services": ["Lightbulb"] },
                { "accessory_id": "lock", "name": "Front door", "services": ["HMServiceTypeLockMechanism"] },
                { "accessory_id": "garage", "services": ["GarageDoorOpener"] },
            ]))
            .unwrap(),
            now,
        )
        .unwrap();
    let lamp = classify(&store, "user:u1", "dev-1", "lamp", now + 1);
    assert!(!lamp.security_class);
    assert_eq!(lamp.name.as_deref(), Some("Desk lamp"));
    assert!(classify(&store, "user:u1", "dev-1", "lock", now).security_class);
    assert!(classify(&store, "user:u1", "dev-1", "garage", now).security_class);
    assert!(classify(&store, "user:u1", "dev-1", "unknown", now).security_class);
    assert!(
        classify(&store, "user:u1", "dev-2", "lamp", now).security_class,
        "the cache is per device"
    );
    assert!(
        classify(
            &store,
            "user:u1",
            "dev-1",
            "lamp",
            now + home::STALE_AFTER_MS + 1
        )
        .security_class,
        "a snapshot older than a day proves nothing"
    );
    // A new post replaces the whole snapshot.
    store
        .replace_home_accessories("user:u1", "dev-1", &[], now + 2)
        .unwrap();
    assert!(classify(&store, "user:u1", "dev-1", "lamp", now + 3).security_class);
}

#[test]
fn an_approval_needs_a_fresh_user_presence_signature_and_a_deny_does_not() {
    let (confirm_key, confirm_spki) = test_key(41);
    let spki = super::identity::decode_public_key(&confirm_spki).unwrap();
    let now = 1_800_000_000_000;
    let signature = sign_b64(
        &confirm_key,
        &confirm_message("perm-dev-x", "h1", "allow_once", now),
    );
    let confirmation = |option: &'static str, hash: &'static str, sig: Option<&str>| {
        verify_confirmation(
            &Confirmation {
                request_id: "perm-dev-x",
                input_sha256: hash,
                option_id: option,
                confirmed_at_ms: now,
                signature: sig,
            },
            Some(&spki),
            now + 1,
        )
    };
    assert_eq!(confirmation("allow_once", "h1", Some(&signature)), Ok(()));
    assert_eq!(
        confirmation("allow_once", "h2", Some(&signature)),
        Err(ConfirmError::BadSignature),
        "bound to the input hash"
    );
    assert_eq!(
        confirmation("allow_once", "h1", None),
        Err(ConfirmError::BadSignature)
    );
    assert_eq!(confirmation("deny", "h1", None), Ok(()));
    let (other_key, _) = test_key(42);
    let forged = sign_b64(
        &other_key,
        &confirm_message("perm-dev-x", "h1", "allow_once", now),
    );
    assert_eq!(
        confirmation("allow_once", "h1", Some(&forged)),
        Err(ConfirmError::BadSignature),
        "the device signing key is not the user-presence key"
    );
    let stale = verify_confirmation(
        &Confirmation {
            request_id: "perm-dev-x",
            input_sha256: "h1",
            option_id: "allow_once",
            confirmed_at_ms: now,
            signature: Some(&signature),
        },
        Some(&spki),
        now + 10 * 60 * 1000,
    );
    assert_eq!(stale, Err(ConfirmError::BadSignature));
    assert_eq!(
        verify_confirmation(
            &Confirmation {
                request_id: "perm-dev-x",
                input_sha256: "h1",
                option_id: "allow_once",
                confirmed_at_ms: now,
                signature: Some(&signature),
            },
            None,
            now
        ),
        Err(ConfirmError::NoConfirmKey)
    );
}

/// A paired iPhone with Home granted, its accessory cache, and (optionally)
/// a confirmation key.
fn home_offer(with_confirm_key: bool) -> DeviceOffer {
    let device_id = uuid::Uuid::new_v4().to_string();
    let principal = DevicePrincipal::User(format!("home-{}", uuid::Uuid::new_v4().simple()));
    let store = store().expect("test store");
    store
        .pair(
            &NewDevice {
                principal_id: &principal.id(),
                device_id: &device_id,
                public_key: b"signing-key",
                app: "ryu-bot",
                platform: "ios",
                label: "Alex's iPhone",
                attestation: None,
                initial_state: DeviceState::Active,
            },
            now_ms(),
        )
        .unwrap();
    if with_confirm_key {
        let (_key, spki) = test_key(43);
        let der = super::identity::decode_public_key(&spki).unwrap();
        store
            .set_confirm_key(&principal.id(), &device_id, Some(&der), now_ms())
            .unwrap();
    }
    store
        .replace_home_accessories(
            &principal.id(),
            &device_id,
            &parse_accessories(&json!([
                { "accessory_id": "lamp", "name": "Desk lamp", "services": ["Lightbulb"] },
                { "accessory_id": "lock", "name": "Front door", "services": ["LockMechanism"] },
            ]))
            .unwrap(),
            now_ms(),
        )
        .unwrap();
    presence::refresh(&principal.id(), &device_id, true, now_ms());
    let decl: ClientDeviceDecl = serde_json::from_value(json!({
        "device_id": device_id, "app": "ryu-bot", "platform": "ios", "label": "Alex's iPhone",
        "foreground": true, "catalog_version": 1,
        "tools": [{ "app": "home", "permission": "granted" }],
    }))
    .unwrap();
    DeviceOffer::new(
        format!("conv-{}", uuid::Uuid::new_v4().simple()),
        principal,
        decl,
        ApprovalMode::Smart,
    )
}

async fn next_card(events: &mut mpsc::UnboundedReceiver<DeviceUiEvent>) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            Ok(Some(DeviceUiEvent::Data { name, data, .. })) if name == "ryu-permission" => {
                return data
            }
            Ok(Some(_)) => continue,
            other => panic!("no permission card: {other:?}"),
        }
    }
}

fn set_input(accessory: &str) -> Value {
    json!({ "accessory_id": accessory, "characteristic_id": "power", "value": true })
}

#[tokio::test]
async fn a_lamp_is_asked_anywhere_but_a_lock_only_on_the_phone() {
    let offer = home_offer(true);
    let principal = offer.principal.id();
    let device = offer.origin.device_id.clone();

    // The lamp: an ordinary card any surface may answer; never Always allow.
    let (tx, mut events) = mpsc::unbounded_channel();
    let lamp = dispatch_call(
        &offer,
        "call-lamp",
        "device_home_set",
        set_input("lamp"),
        &tx,
    );
    let driver = async {
        let card = next_card(&mut events).await;
        assert_eq!(card["device"]["requiresOnDeviceConfirmation"], false);
        assert!(card["device"].get("inputSha256").is_none());
        assert_eq!(
            card["toolCall"]["title"],
            "Change Home accessory “Desk lamp” · on “Alex's iPhone”"
        );
        let offered: Vec<&str> = card["options"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|o| o["optionId"].as_str())
            .collect();
        assert!(
            !offered.contains(&"allow_always"),
            "home.set is never persistable"
        );
        let id = card["requestId"].as_str().unwrap();
        assert_eq!(
            prompts::resolve(id, Some("deny"), &principal),
            Ok(PromptAnswer::Deny)
        );
    };
    let (result, ()) = tokio::join!(lamp, driver);
    assert_eq!(result["code"], "cancelled_by_user");

    // The lock: only the target phone, with its user-presence key.
    let (tx, mut events) = mpsc::unbounded_channel();
    let lock = dispatch_call(
        &offer,
        "call-lock",
        "device_home_set",
        set_input("lock"),
        &tx,
    );
    let driver = async {
        let card = next_card(&mut events).await;
        assert_eq!(card["device"]["requiresOnDeviceConfirmation"], true);
        let hash = card["device"]["inputSha256"].as_str().unwrap().to_owned();
        let id = card["requestId"].as_str().unwrap().to_owned();
        assert_eq!(
            prompts::resolve(&id, Some("allow_once"), &principal),
            Err(ResolveError::OnDeviceOnly),
            "the desktop cannot approve a lock"
        );
        assert_eq!(
            prompts::confirm_on_device(&id, "allow_once", &principal, "another-phone", &hash),
            Err(ResolveError::Unknown)
        );
        assert_eq!(
            prompts::confirm_on_device(&id, "allow_once", &principal, &device, "other-hash"),
            Err(ResolveError::InputMismatch)
        );
        assert_eq!(
            prompts::confirm_on_device(&id, "allow_once", &principal, &device, &hash),
            Ok(PromptAnswer::AllowOnce)
        );
        let grant = loop {
            match claims::claim(&ClaimRequest {
                conversation_id: &offer.conversation_id,
                tool_call_id: "call-lock",
                principal_id: &principal,
                device_id: &device,
                phase: ClaimPhase::Execute,
                foreground: true,
                now_ms: now_ms(),
            }) {
                Ok(grant) => break grant,
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        };
        assert!(grant.security_confirmed, "the phone may write the lock");
        assert_eq!(grant.input_sha256, hash);
        claims::submit_result(ResultSubmission {
            conversation_id: &offer.conversation_id,
            tool_call_id: "call-lock",
            claim_id: &grant.claim_id,
            principal_id: &principal,
            device_id: &device,
            input_sha256: &grant.input_sha256,
            result: json!({ "ok": true, "data": {} }),
            now_ms: now_ms(),
        })
        .unwrap();
    };
    let (result, ()) = tokio::join!(lock, driver);
    assert_eq!(result["ok"], true, "{result}");
}

#[tokio::test]
async fn a_lock_on_a_phone_without_a_confirmation_key_is_refused_at_once() {
    let offer = home_offer(false);
    let (tx, _events) = mpsc::unbounded_channel();
    let result = dispatch_call(
        &offer,
        "call-nokey",
        "device_home_set",
        set_input("lock"),
        &tx,
    )
    .await;
    assert_eq!(result["code"], "approval_required", "{result}");
    // An accessory the phone never reported is treated like a lock.
    let (tx, _events) = mpsc::unbounded_channel();
    let result = dispatch_call(
        &offer,
        "call-unknown",
        "device_home_set",
        set_input("safe"),
        &tx,
    )
    .await;
    assert_eq!(result["code"], "approval_required", "{result}");
}
