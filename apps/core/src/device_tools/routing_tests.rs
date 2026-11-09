//! Device routing (design §1.5): the pure choice, and a cross-device call end
//! to end through `dispatch_call` (always asks, frames only on the target's
//! device stream, claimed by the target).

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::claims::{self, ClaimPhase, ClaimRequest, ResultSubmission};
use super::declaration::{AppPermission, ClientDeviceDecl};
use super::dispatch::dispatch_call;
use super::frames::DeviceUiEvent;
use super::identity::DevicePrincipal;
use super::offer::DeviceOffer;
use super::registry::{store, DeviceState, NewDevice};
use super::routing::{choose, choose_pinned, Candidate, Route};
use super::{device_stream, now_ms, presence, prompts, routing};

fn candidate(id: &str, permission: Option<AppPermission>) -> Candidate {
    Candidate {
        device_id: id.to_owned(),
        label: format!("{id} phone"),
        platform: "ios".to_owned(),
        paired_at_ms: 100,
        last_seen_ms: 1_000,
        foreground: true,
        reachable: true,
        permission,
        user_disabled: false,
    }
}

fn target_id(route: &Route) -> Option<(&str, bool, bool)> {
    match route {
        Route::Target {
            device_id,
            cross_device,
            needs_permission,
            ..
        } => Some((device_id.as_str(), *cross_device, *needs_permission)),
        _ => None,
    }
}

#[test]
fn origin_is_preferred_even_when_it_still_needs_the_os_prompt() {
    let origin = candidate("origin", Some(AppPermission::Undetermined));
    let other = candidate("other", Some(AppPermission::Granted));
    let route = choose(&origin, &[other], "calendar", 500);
    assert_eq!(target_id(&route), Some(("origin", false, true)));
}

#[test]
fn falls_back_to_the_most_recent_granted_phone_and_ignores_stale_or_unreachable_ones() {
    let mut origin = candidate("origin", Some(AppPermission::Granted));
    origin.foreground = false;
    let mut older = candidate("older", Some(AppPermission::Granted));
    older.last_seen_ms = 10;
    let newer = candidate("newer", Some(AppPermission::Limited));
    let mut stale = candidate("stale", Some(AppPermission::Granted));
    stale.foreground = false;
    stale.last_seen_ms = 9_999;
    let mut no_stream = candidate("no-stream", Some(AppPermission::Granted));
    no_stream.reachable = false;
    no_stream.last_seen_ms = 9_999;
    let undecided = {
        let mut phone = candidate("undecided", Some(AppPermission::Undetermined));
        phone.last_seen_ms = 99_999;
        phone
    };
    let route = choose(
        &origin,
        &[older, newer, stale, no_stream, undecided],
        "location",
        500,
    );
    assert_eq!(target_id(&route), Some(("newer", true, false)));
}

#[test]
fn an_undecided_phone_gets_the_permission_card_when_none_is_granted() {
    let mut origin = candidate("origin", Some(AppPermission::Granted));
    origin.foreground = false;
    let undecided = candidate("undecided", Some(AppPermission::Denied));
    let disabled = Candidate {
        user_disabled: true,
        ..candidate("disabled", Some(AppPermission::Granted))
    };
    let restricted = candidate("restricted", Some(AppPermission::Restricted));
    let route = choose(&origin, &[disabled, restricted, undecided], "contacts", 500);
    assert_eq!(target_id(&route), Some(("undecided", true, true)));
}

#[test]
fn never_assigns_a_phone_paired_after_the_call_was_created() {
    let mut origin = candidate("origin", Some(AppPermission::Granted));
    origin.foreground = false;
    let mut late = candidate("late", Some(AppPermission::Granted));
    late.paired_at_ms = 600;
    assert_eq!(choose(&origin, &[late], "alarms", 500), Route::Wait);
}

#[test]
fn platform_mismatch_fails_at_once() {
    let android = Candidate {
        platform: "android".to_owned(),
        ..candidate("origin", Some(AppPermission::Granted))
    };
    let other = Candidate {
        platform: "android".to_owned(),
        ..candidate("other", Some(AppPermission::Granted))
    };
    assert_eq!(
        choose(&android, &[other], "reminders", 500),
        Route::UnsupportedPlatform
    );
    let mut away = candidate("origin", Some(AppPermission::Granted));
    away.foreground = false;
    assert_eq!(choose(&away, &[], "reminders", 500), Route::Wait);
}

#[test]
fn a_pinned_target_never_moves() {
    let mut pinned = candidate("pinned", Some(AppPermission::Granted));
    pinned.foreground = false;
    assert_eq!(
        choose_pinned(&pinned, "origin", "calendar", 500),
        Route::Wait
    );
    pinned.foreground = true;
    assert_eq!(
        target_id(&choose_pinned(&pinned, "origin", "calendar", 500)),
        Some(("pinned", true, false))
    );
}

fn pair(principal: &DevicePrincipal, device_id: &str, label: &str) {
    store()
        .expect("test store")
        .pair(
            &NewDevice {
                principal_id: &principal.id(),
                device_id,
                public_key: b"test-key",
                app: "ryu-bot",
                platform: "ios",
                label,
                attestation: None,
                initial_state: DeviceState::Active,
            },
            now_ms() - 1_000,
        )
        .unwrap();
}

fn decl(device_id: &str, foreground: bool, tools: Value) -> ClientDeviceDecl {
    serde_json::from_value(json!({
        "device_id": device_id, "app": "ryu-bot", "platform": "ios",
        "foreground": foreground, "catalog_version": 1, "tools": tools,
    }))
    .unwrap()
}

async fn next_event(events: &mut mpsc::UnboundedReceiver<DeviceUiEvent>, name: &str) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            Ok(Some(DeviceUiEvent::Data { name: n, data, .. })) if n == name => return data,
            Ok(Some(_)) => continue,
            other => panic!("no {name} frame: {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_cross_device_call_always_asks_and_reaches_only_the_target_stream() {
    let principal = DevicePrincipal::User(format!("route-{}", uuid::Uuid::new_v4().simple()));
    let origin_id = uuid::Uuid::new_v4().to_string();
    let target_id = uuid::Uuid::new_v4().to_string();
    pair(&principal, &origin_id, "Alex's iPad");
    pair(&principal, &target_id, "Alex's iPhone");
    // The origin declared no location app; the iPhone has it granted, is in
    // the foreground and holds its device stream.
    let origin = decl(&origin_id, true, json!([]));
    presence::refresh_with_decl(&principal.id(), &origin_id, &origin, now_ms());
    let phone = decl(
        &target_id,
        true,
        json!([{ "app": "location", "permission": "granted" }]),
    );
    presence::refresh_with_decl(&principal.id(), &target_id, &phone, now_ms());
    let (mut target_stream, _guard) = device_stream::connect(&principal.id(), &target_id);
    // Even an Always-allow grant on the target does not skip the ask.
    store()
        .unwrap()
        .grant(
            &principal.id(),
            &target_id,
            "device.location.current",
            now_ms(),
        )
        .unwrap();

    let peers = routing::other_device_apps(&store().unwrap(), &principal.id(), &origin_id);
    assert_eq!(peers, vec!["location".to_owned()]);
    let offer = DeviceOffer::new(
        format!("conv-{}", uuid::Uuid::new_v4().simple()),
        principal.clone(),
        origin,
        crate::approvals::policy::ApprovalMode::Off,
    )
    .with_caps_and_peers(super::caps::DeviceToolCaps::none(), &peers);
    assert!(offer.offers("device.location.current"));

    let (tx, mut turn) = mpsc::unbounded_channel();
    let call = dispatch_call(&offer, "call-x", "device_location_current", json!({}), &tx);
    let driver = async {
        let card = next_event(&mut turn, "ryu-permission").await;
        let options: Vec<&str> = card["options"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|o| o["optionId"].as_str())
            .collect();
        assert_eq!(
            options,
            vec!["allow_once", "deny"],
            "no Always allow cross-device"
        );
        assert_eq!(card["device"]["deviceId"], target_id.as_str());
        let id = card["requestId"].as_str().unwrap().to_owned();
        prompts::resolve(&id, Some("allow_once"), &principal.id()).unwrap();
        let request = match tokio::time::timeout(Duration::from_secs(5), target_stream.recv()).await
        {
            Ok(Some(DeviceUiEvent::Data { name, data, .. })) if name == "device-tool-request" => {
                data
            }
            other => panic!("no routed request: {other:?}"),
        };
        assert_eq!(request["targetDeviceId"], target_id.as_str());
        assert!(request.get("input").is_none());
        // The origin cannot claim a call pinned to the iPhone.
        let claim = |device_id: &str| {
            claims::claim(&ClaimRequest {
                conversation_id: &offer.conversation_id,
                tool_call_id: "call-x",
                principal_id: &principal.id(),
                device_id,
                phase: ClaimPhase::Execute,
                foreground: true,
                now_ms: now_ms(),
            })
        };
        assert_eq!(claim(&origin_id), Err(super::DeviceErrorCode::NotFound));
        let grant = claim(&target_id).unwrap();
        claims::submit_result(ResultSubmission {
            conversation_id: &offer.conversation_id,
            tool_call_id: "call-x",
            claim_id: &grant.claim_id,
            principal_id: &principal.id(),
            device_id: &target_id,
            input_sha256: &grant.input_sha256,
            result: json!({ "ok": true, "data": { "latitude": 1.0, "longitude": 2.0, "approximate": true } }),
            now_ms: now_ms(),
        })
        .unwrap();
    };
    let (result, ()) = tokio::join!(call, driver);
    assert_eq!(result["ok"], true, "{result}");
    let mut turn_frames = Vec::new();
    while let Ok(event) = turn.try_recv() {
        if let DeviceUiEvent::Data { name, .. } = event {
            turn_frames.push(name);
        }
    }
    assert!(
        !turn_frames.iter().any(|name| name == "device-tool-request"),
        "the turn stream gets status only: {turn_frames:?}"
    );
}
