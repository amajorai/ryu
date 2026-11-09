//! P4: the feasibility spike, the parked-call store, and park → Retry end to
//! end through `dispatch_call`.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::catalog::catalog;
use super::claims::{self, ClaimPhase, ClaimRequest, ResultSubmission};
use super::declaration::ClientDeviceDecl;
use super::dispatch::dispatch_call;
use super::display;
use super::frames::DeviceUiEvent;
use super::identity::DevicePrincipal;
use super::offer::DeviceOffer;
use super::pending::{ParkedApproval, ParkedCall, PendingStore};
use super::registry::{store, DeviceState, NewDevice};
use super::{now_ms, presence, prompts};

/// The spike's deciding fact for the OpenAI plane: a detached resume turn can
/// only rebuild history from persisted parts, and the persisted tool output is
/// the redacted display form, which by design no longer holds what the model
/// needs. Delivering the real result would need a hidden, Core-authored
/// message, which the review forbade, so P4 ships the Retry fallback.
#[test]
fn spike_persisted_history_cannot_carry_a_device_result() {
    let tool = catalog().tool("device.location.current").unwrap();
    let full = json!({ "ok": true, "data": { "latitude": 37.3349, "longitude": -122.009, "approximate": true } });
    let persisted = display::redact_result_for_display(tool, &full).to_string();
    assert!(!persisted.contains("37.33") && !persisted.contains("latitude"));
    let contacts = catalog().tool("device.contacts.search").unwrap();
    let found = json!({ "ok": true, "data": { "access": "full", "contacts": [
        { "id": "1", "name": "Sam", "phones": ["+1 555 0100"] } ] } });
    let persisted = display::redact_result_for_display(contacts, &found).to_string();
    assert!(!persisted.contains("555"), "{persisted}");
}

fn parked(conversation: &str, call: &str, target: Option<&str>, until: i64) -> ParkedCall {
    ParkedCall {
        conversation_id: conversation.to_owned(),
        tool_call_id: call.to_owned(),
        owner_principal_id: "user:p".to_owned(),
        target_device_id: target.map(str::to_owned),
        tool: "device.calendar.create".to_owned(),
        approval: ParkedApproval::AllowOnce,
        created_ms: 1_000,
        resumable_until_ms: until,
    }
}

#[test]
fn a_parked_call_matches_only_its_owner_tool_and_exact_input_once() {
    let store = PendingStore::open_in_memory().unwrap();
    store
        .park(&parked("c1", "t1", Some("dev-1"), 10_000), "hash-a", 2_000)
        .unwrap();
    let take = |owner: &str, tool: &str, hash: &str, now: i64| {
        store.take_match("c1", owner, tool, hash, now)
    };
    assert!(take("user:p", "device.calendar.create", "hash-b", 3_000).is_none());
    assert!(take("user:q", "device.calendar.create", "hash-a", 3_000).is_none());
    assert!(take("user:p", "device.calendar.delete", "hash-a", 3_000).is_none());
    assert!(
        take("user:p", "device.calendar.create", "hash-a", 10_000).is_none(),
        "expired"
    );
    let row = take("user:p", "device.calendar.create", "hash-a", 3_000).expect("match");
    assert_eq!(row.target_device_id.as_deref(), Some("dev-1"));
    assert_eq!(row.approval, ParkedApproval::AllowOnce);
    assert_eq!(row.resumable_until_ms, 10_000, "never extended");
    assert!(
        take("user:p", "device.calendar.create", "hash-a", 3_000).is_none(),
        "single use"
    );
}

#[test]
fn cancel_and_forget_clear_parked_calls_and_the_input_hash_is_not_stored() {
    let store = PendingStore::open_in_memory().unwrap();
    store
        .park(&parked("c2", "t1", Some("dev-1"), 9_000), "hash-a", 2_000)
        .unwrap();
    store
        .park(&parked("c2", "t2", Some("dev-2"), 9_000), "hash-b", 2_000)
        .unwrap();
    store
        .park(&parked("c3", "t3", None, 9_000), "hash-c", 2_000)
        .unwrap();
    assert_eq!(store.forget_device("user:p", "dev-1"), 1);
    assert_eq!(store.cancel_conversation("c2"), 1);
    assert!(store
        .take_match("c2", "user:p", "device.calendar.create", "hash-b", 3_000)
        .is_none());
    assert!(store
        .take_match("c3", "user:p", "device.calendar.create", "hash-c", 3_000)
        .is_some());
}

#[test]
fn parked_calls_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("device_tools.db");
    PendingStore::open(&path)
        .unwrap()
        .park(
            &parked("c4", "t4", Some("dev-4"), now_ms() + 60_000),
            "hash-r",
            now_ms(),
        )
        .unwrap();
    let raw = std::fs::read(&path).unwrap();
    assert!(
        !raw.windows(6).any(|window| window == b"hash-r"),
        "only a salted binding is stored"
    );
    let reopened = PendingStore::open(&path).unwrap();
    let row = reopened
        .take_match("c4", "user:p", "device.calendar.create", "hash-r", now_ms())
        .expect("re-hydrated");
    assert_eq!(row.approval, ParkedApproval::AllowOnce);
    assert_eq!(row.target_device_id.as_deref(), Some("dev-4"));
}

fn location_offer(foreground: bool) -> DeviceOffer {
    let device_id = uuid::Uuid::new_v4().to_string();
    let principal = DevicePrincipal::User(format!("park-{}", uuid::Uuid::new_v4().simple()));
    store()
        .expect("test store")
        .pair(
            &NewDevice {
                principal_id: &principal.id(),
                device_id: &device_id,
                public_key: b"test-key",
                app: "ryu-bot",
                platform: "ios",
                label: "Alex's iPhone",
                attestation: None,
                initial_state: DeviceState::Active,
            },
            now_ms() - 1_000,
        )
        .unwrap();
    let decl: ClientDeviceDecl = serde_json::from_value(json!({
        "device_id": device_id, "app": "ryu-bot", "platform": "ios", "label": "Alex's iPhone",
        "foreground": foreground, "catalog_version": 1,
        "tools": [{ "app": "location", "permission": "granted" }],
    }))
    .unwrap();
    presence::refresh_with_decl(&principal.id(), &device_id, &decl, now_ms());
    let mut offer = DeviceOffer::new(
        format!("conv-{}", uuid::Uuid::new_v4().simple()),
        principal,
        decl,
        crate::approvals::policy::ApprovalMode::Smart,
    );
    offer.wait_window_ms = 300;
    offer
}

fn drain(events: &mut mpsc::UnboundedReceiver<DeviceUiEvent>) -> Vec<(String, Value)> {
    let mut frames = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let DeviceUiEvent::Data { name, data, .. } = event {
            frames.push((name, data));
        }
    }
    frames
}

#[tokio::test]
async fn an_unclaimed_approved_call_parks_and_a_retry_reuses_its_approval() {
    let offer = location_offer(true);
    let (tx, mut events) = mpsc::unbounded_channel();
    let call = dispatch_call(&offer, "call-p1", "device_location_current", json!({}), &tx);
    let approve = async {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Some(DeviceUiEvent::Data { name, data, .. })) if name == "ryu-permission" => {
                    let id = data["requestId"].as_str().unwrap().to_owned();
                    prompts::resolve(&id, Some("allow_once"), &offer.principal.id()).unwrap();
                    break;
                }
                Ok(Some(_)) => {}
                other => panic!("no approval card: {other:?}"),
            }
        }
    };
    let (parked, ()) = tokio::join!(call, approve);
    assert_eq!(parked["code"], "pending_on_device", "{parked}");
    let message = parked["message"].as_str().unwrap();
    assert!(message.contains("\u{201c}Alex's iPhone\u{201d}") && message.contains("Retry"));
    let frames = drain(&mut events);
    let card = frames
        .iter()
        .find(|(name, data)| name == "device-tool-status" && data["state"] == "parked")
        .expect("parked card");
    assert_eq!(card.1["retry"], true);
    assert!(card.1["resumableUntilMs"].as_i64().unwrap() > now_ms());
    // The card is structured for the client to localize; no English sentence.
    assert!(card.1.get("message").is_none(), "{}", card.1);
    assert_eq!(card.1["deviceLabel"], "Alex's iPhone");
    assert!(card.1["app"].as_str().is_some_and(|app| !app.is_empty()));
    assert!(card.1["appName"]
        .as_str()
        .is_some_and(|name| !name.is_empty()));

    // "Retry phone action": the model calls the same tool with the same
    // input; the recorded approval is reused, so no second card.
    let (tx, mut events) = mpsc::unbounded_channel();
    let retry = dispatch_call(&offer, "call-p2", "device_location_current", json!({}), &tx);
    let phone = async {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Some(DeviceUiEvent::Data { name, .. })) if name == "ryu-permission" => {
                    panic!("the retry must not ask again")
                }
                Ok(Some(DeviceUiEvent::Data { name, .. })) if name == "device-tool-request" => {
                    break
                }
                Ok(Some(_)) => {}
                other => panic!("no request frame: {other:?}"),
            }
        }
        let grant = claims::claim(&ClaimRequest {
            conversation_id: &offer.conversation_id,
            tool_call_id: "call-p2",
            principal_id: &offer.principal.id(),
            device_id: &offer.origin.device_id,
            phase: ClaimPhase::Execute,
            foreground: true,
            now_ms: now_ms(),
        })
        .unwrap();
        claims::submit_result(ResultSubmission {
            conversation_id: &offer.conversation_id,
            tool_call_id: "call-p2",
            claim_id: &grant.claim_id,
            principal_id: &offer.principal.id(),
            device_id: &offer.origin.device_id,
            input_sha256: &grant.input_sha256,
            result: json!({ "ok": true, "data": { "latitude": 1.0, "longitude": 2.0, "approximate": true } }),
            now_ms: now_ms(),
        })
        .unwrap();
    };
    let (result, ()) = tokio::join!(retry, phone);
    assert_eq!(result["ok"], true, "{result}");

    // The parked row was consumed: a third identical call asks again.
    let (tx, mut events) = mpsc::unbounded_channel();
    let third = dispatch_call(&offer, "call-p3", "device_location_current", json!({}), &tx);
    let deny = async {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Some(DeviceUiEvent::Data { name, data, .. })) if name == "ryu-permission" => {
                    let id = data["requestId"].as_str().unwrap().to_owned();
                    prompts::resolve(&id, Some("deny"), &offer.principal.id()).unwrap();
                    break;
                }
                Ok(Some(_)) => {}
                other => panic!("no card on the third call: {other:?}"),
            }
        }
    };
    let (denied, ()) = tokio::join!(third, deny);
    assert_eq!(denied["code"], "cancelled_by_user");
}

#[tokio::test]
async fn no_reachable_phone_waits_then_parks_without_a_target() {
    let offer = location_offer(false);
    let (tx, mut events) = mpsc::unbounded_channel();
    let result = dispatch_call(&offer, "call-w1", "device_location_current", json!({}), &tx).await;
    assert_eq!(result["code"], "pending_on_device", "{result}");
    let frames = drain(&mut events);
    assert!(frames
        .iter()
        .any(|(name, data)| name == "device-tool-status" && data["state"] == "waiting-device"));
    assert!(
        !frames.iter().any(|(name, _)| name == "ryu-permission"),
        "no approval before a target exists"
    );
    let row = super::pending::store()
        .unwrap()
        .take_match(
            &offer.conversation_id,
            &offer.principal.id(),
            "device.location.current",
            &super::validate::input_sha256(&json!({ "accuracy": "approximate" })),
            now_ms(),
        )
        .expect("parked");
    assert_eq!(row.target_device_id, None);
    assert_eq!(row.approval, ParkedApproval::None);
}

#[tokio::test]
async fn a_waiting_call_proceeds_when_the_phone_comes_back() {
    let mut offer = location_offer(false);
    offer.wait_window_ms = 5_000;
    let (tx, mut events) = mpsc::unbounded_channel();
    let call = dispatch_call(&offer, "call-w2", "device_location_current", json!({}), &tx);
    let wake = async {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Some(DeviceUiEvent::Data { name, data, .. }))
                    if name == "device-tool-status" && data["state"] == "waiting-device" =>
                {
                    break
                }
                Ok(Some(_)) => {}
                other => panic!("no waiting frame: {other:?}"),
            }
        }
        presence::refresh_with_decl(
            &offer.principal.id(),
            &offer.origin.device_id,
            &ClientDeviceDecl {
                foreground: true,
                ..offer.origin.clone()
            },
            now_ms(),
        );
        loop {
            match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Some(DeviceUiEvent::Data { name, data, .. })) if name == "ryu-permission" => {
                    let id = data["requestId"].as_str().unwrap().to_owned();
                    prompts::resolve(&id, Some("deny"), &offer.principal.id()).unwrap();
                    break;
                }
                Ok(Some(_)) => {}
                other => panic!("no card after the phone came back: {other:?}"),
            }
        }
    };
    let (result, ()) = tokio::join!(call, wake);
    assert_eq!(result["code"], "cancelled_by_user", "{result}");
}

#[tokio::test]
async fn a_tainted_turn_does_not_reuse_a_parked_approval() {
    let offer = location_offer(true);
    super::pending::store()
        .unwrap()
        .park(
            &ParkedCall {
                conversation_id: offer.conversation_id.clone(),
                tool_call_id: "call-old".to_owned(),
                owner_principal_id: offer.principal.id(),
                target_device_id: Some(offer.origin.device_id.clone()),
                tool: "device.location.current".to_owned(),
                approval: ParkedApproval::AllowOnce,
                created_ms: now_ms() - 1_000,
                resumable_until_ms: now_ms() + 60_000,
            },
            &super::validate::input_sha256(&json!({ "accuracy": "approximate" })),
            now_ms(),
        )
        .unwrap();
    // The turn read untrusted content (a web page, an email) first.
    offer.mark_tainted_input();
    let (tx, mut events) = mpsc::unbounded_channel();
    let call = dispatch_call(&offer, "call-t1", "device_location_current", json!({}), &tx);
    let deny = async {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
                Ok(Some(DeviceUiEvent::Data { name, data, .. })) if name == "ryu-permission" => {
                    let id = data["requestId"].as_str().unwrap().to_owned();
                    prompts::resolve(&id, Some("deny"), &offer.principal.id()).unwrap();
                    break;
                }
                Ok(Some(_)) => {}
                other => panic!("a tainted turn must ask again: {other:?}"),
            }
        }
    };
    let (result, ()) = tokio::join!(call, deny);
    assert_eq!(result["code"], "cancelled_by_user");
}
