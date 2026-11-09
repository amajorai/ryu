//! Per-caller admin caps (P5): parsing fails closed, caps only restrict, the
//! resolver serves last-known-good on an outage and drops it on a refusal,
//! and a `never` app is never offered.

use serde_json::json;

use super::caps::DeviceToolCaps;
use super::caps_resolver::{age_for_tests, caps_from_policy_response, resolve_at, FetchError};
use super::catalog::catalog;
use super::declaration::ClientDeviceDecl;
use super::gate::{decide, AdminCap, GateDecision, GateFacts};
use super::identity::DevicePrincipal;
use super::offer::DeviceOffer;
use crate::approvals::policy::ApprovalMode;

#[test]
fn wire_caps_parse_and_fail_closed() {
    assert_eq!(DeviceToolCaps::from_wire(None), DeviceToolCaps::none());
    assert_eq!(
        DeviceToolCaps::from_wire(Some(&json!(null))),
        DeviceToolCaps::none()
    );
    let caps = DeviceToolCaps::from_wire(Some(&json!({
        "calendar": "always", "contacts": "ask", "location": "never",
        "alarms": "sometimes", "teleport": "always",
    })));
    assert_eq!(caps.cap_for("calendar"), AdminCap::Always);
    assert_eq!(caps.cap_for("contacts"), AdminCap::Ask);
    assert_eq!(caps.cap_for("location"), AdminCap::Never);
    assert_eq!(caps.cap_for("alarms"), AdminCap::Never, "unknown value");
    assert_eq!(caps.cap_for("reminders"), AdminCap::None, "no cap set");
    assert_eq!(
        caps.to_json(),
        json!({ "alarms": "never", "calendar": "always", "contacts": "ask", "location": "never" })
    );
    let garbage = DeviceToolCaps::from_wire(Some(&json!("open")));
    assert_eq!(garbage.cap_for("calendar"), AdminCap::Never);
    assert_eq!(garbage.to_json(), json!("never"));
    assert_eq!(DeviceToolCaps::never().cap_for("alarms"), AdminCap::Never);
}

#[test]
fn the_policy_answer_must_be_for_this_nodes_org() {
    let body = json!({
        "organizationId": "org-1",
        "policy": { "rules": { "deniedTools": [], "deviceToolCaps": { "location": "ask" } } },
    });
    let caps = caps_from_policy_response(&body, "org-1").ok().unwrap();
    assert_eq!(caps.cap_for("location"), AdminCap::Ask);
    assert!(matches!(
        caps_from_policy_response(&body, "org-2"),
        Err(FetchError::Unavailable(_))
    ));
    let older = json!({ "organizationId": "org-1", "policy": { "rules": {} } });
    assert_eq!(
        caps_from_policy_response(&older, "org-1").ok().unwrap(),
        DeviceToolCaps::none()
    );
}

fn ask_caps() -> DeviceToolCaps {
    DeviceToolCaps::from_wire(Some(&json!({ "calendar": "ask" })))
}

#[tokio::test]
async fn resolver_caches_serves_last_known_good_and_drops_on_refusal() {
    let key = format!("org\0team\0{}", uuid::Uuid::new_v4().simple());
    // No answer ever: fail closed to never.
    let none = resolve_at(&key, || async {
        Err::<DeviceToolCaps, _>(FetchError::Unavailable("down".into()))
    })
    .await;
    assert_eq!(none, DeviceToolCaps::never());
    let first = resolve_at(&key, || async { Ok(ask_caps()) }).await;
    assert_eq!(first, ask_caps());
    // Fresh: the fetch is not called.
    let cached = resolve_at(&key, || async {
        panic!("fresh cache must not refetch");
        #[allow(unreachable_code)]
        Ok(DeviceToolCaps::none())
    })
    .await;
    assert_eq!(cached, ask_caps());
    // Stale and the control plane is down: last-known-good.
    age_for_tests(&key);
    let outage = resolve_at(&key, || async {
        Err::<DeviceToolCaps, _>(FetchError::Unavailable("timeout".into()))
    })
    .await;
    assert_eq!(outage, ask_caps());
    // An authoritative refusal drops it: never, and never again from cache.
    let refused = resolve_at(&key, || async {
        Err::<DeviceToolCaps, _>(FetchError::Refused(403))
    })
    .await;
    assert_eq!(refused, DeviceToolCaps::never());
    let after = resolve_at(&key, || async {
        Err::<DeviceToolCaps, _>(FetchError::Unavailable("down".into()))
    })
    .await;
    assert_eq!(after, DeviceToolCaps::never());
}

#[tokio::test]
async fn a_personal_unbound_node_has_no_caps() {
    let caps = super::caps_resolver::caps_for(&DevicePrincipal::LocalOwner).await;
    assert_eq!(caps, DeviceToolCaps::none());
}

fn facts(cap: AdminCap, has_grant: bool) -> GateFacts<'static> {
    GateFacts {
        tool: catalog().tool("device.calendar.create").unwrap(),
        cap,
        org_denial: None,
        approval_mode: ApprovalMode::Off,
        has_device_grant: has_grant,
        cross_device: false,
        precise_location: false,
        tainted_input: false,
        over_quota: false,
        persistence_allowed: true,
        home_security_class: false,
    }
}

#[test]
fn caps_only_restrict_the_users_own_choice() {
    assert_eq!(decide(&facts(AdminCap::None, true)), GateDecision::Run);
    assert_eq!(
        decide(&facts(AdminCap::Ask, true)),
        GateDecision::Ask {
            allow_always: false,
            on_device: false
        },
        "ask ignores grants and hides Always allow"
    );
    assert_eq!(
        decide(&facts(AdminCap::Always, false)),
        GateDecision::Ask {
            allow_always: true,
            on_device: false
        },
        "always never skips the user's ask"
    );
    assert_eq!(
        decide(&facts(AdminCap::Never, true)),
        GateDecision::Refuse(super::DeviceErrorCode::AdminBlocked)
    );
}

#[test]
fn a_never_app_is_not_offered_and_peer_apps_are() {
    let device_id = uuid::Uuid::new_v4().to_string();
    let decl: ClientDeviceDecl = serde_json::from_value(json!({
        "device_id": device_id, "app": "ryu-bot", "platform": "ios", "foreground": true,
        "catalog_version": 1,
        "tools": [
            { "app": "calendar", "permission": "granted" },
            { "app": "location", "permission": "granted" },
        ],
    }))
    .unwrap();
    let caps = DeviceToolCaps::from_wire(Some(&json!({ "location": "never" })));
    let offer = DeviceOffer::new(
        "conv".into(),
        DevicePrincipal::LocalOwner,
        decl,
        ApprovalMode::Smart,
    )
    .with_caps_and_peers(caps, &["alarms".to_owned(), "location".to_owned()]);
    assert!(offer.offers("device.calendar.search"));
    assert!(offer.offers("device.alarm.set"), "a peer phone's app");
    assert!(!offer.offers("device.location.current"), "capped never");
    assert!(
        !offer.offers("device.reminders.list"),
        "an app no paired phone declared is never offered"
    );
}

#[tokio::test]
async fn an_org_bound_caller_without_resolvable_rules_is_never() {
    use crate::sidecar::control_plane::{
        with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
    };
    let node = RegisteredNode {
        org: RegisteredOrg {
            id: format!("org-{}", uuid::Uuid::new_v4().simple()),
            name: "Org".into(),
            slug: None,
        },
        node_id: "node".into(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    };
    let (user, owner) = with_test_node_binding(true, Some(node), async {
        (
            super::caps_resolver::caps_for(&DevicePrincipal::User("u-caps".into())).await,
            super::caps_resolver::caps_for(&DevicePrincipal::LocalOwner).await,
        )
    })
    .await;
    assert_eq!(user, DeviceToolCaps::never());
    assert_eq!(owner, DeviceToolCaps::never());
}
