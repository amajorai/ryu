//! The broker relay in a cloud task's Box: what the Box's network admits,
//! failing closed before anything is minted, and revocation on recovery.

use super::relay::{network_admits, plan_relay, relay_refusal};
use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::broker::box_relay::{self, BoxRelayOwner};
use crate::vault::broker::{services, sessions};

fn manager() -> BoxRelayOwner {
    BoxRelayOwner {
        subjects: Vec::new(),
        manager: true,
    }
}

async fn relayed_service(store: &PluginSecretStore) {
    let mut input = services::test_service("github", "api.github.com", None, "/");
    input.environment = crate::vault::active_environment();
    input.box_relay = true;
    let conn = store.conn.lock().await;
    services::insert(&conn, input.normalize().unwrap()).unwrap();
}

async fn live_box_sessions(store: &PluginSecretStore, lease: &str) -> usize {
    let conn = store.conn.lock().await;
    sessions::list(&conn)
        .unwrap()
        .iter()
        .filter(|session| session.minted_by == box_relay::subject_for(lease))
        .count()
}

#[test]
fn a_relay_host_must_be_admitted_by_the_box_network() {
    assert!(!network_admits(&BoxNetwork::None, "api.github.com"));
    assert!(network_admits(&BoxNetwork::Egress, "api.github.com"));
    let allowlist = BoxNetwork::Allowlist(vec!["*.github.com".into(), "api.openai.com".into()]);
    assert!(network_admits(&allowlist, "api.github.com"));
    assert!(network_admits(&allowlist, "*.api.github.com"));
    assert!(network_admits(&allowlist, "api.openai.com"));
    assert!(!network_admits(&allowlist, "github.com"));
    assert!(!network_admits(&allowlist, "api.anthropic.com"));
    assert!(network_admits(
        &BoxNetwork::Allowlist(vec!["*".into()]),
        "x.example.com"
    ));
}

#[test]
fn a_relay_without_its_prerequisites_is_refused_plainly() {
    let url = Some("https://node.example.com/api/vault/broker/box-relay");
    assert!(relay_refusal(false, url, true)
        .unwrap()
        .contains("not running"));
    assert!(relay_refusal(true, None, true)
        .unwrap()
        .contains("public https URL"));
    assert!(relay_refusal(true, url, false)
        .unwrap()
        .contains("cannot relay"));
    assert_eq!(relay_refusal(true, url, true), None);
}

#[tokio::test]
async fn a_box_without_relay_services_is_created_as_before() {
    let store = PluginSecretStore::in_memory().unwrap();
    // Unreachable: nothing may be asked of the Box service.
    let client = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token");
    let planned = plan_relay(
        &store,
        "lease-none",
        &manager(),
        &BoxNetwork::Egress,
        600,
        &client,
    )
    .await
    .unwrap();
    assert!(planned.is_none());
    // A Box with no network gets no relay even when services are marked.
    relayed_service(&store).await;
    let planned = plan_relay(
        &store,
        "lease-none",
        &manager(),
        &BoxNetwork::None,
        600,
        &client,
    )
    .await
    .unwrap();
    assert!(planned.is_none());
    assert_eq!(live_box_sessions(&store, "lease-none").await, 0);
}

#[tokio::test]
async fn a_box_that_would_get_relay_services_fails_closed_without_the_broker() {
    let store = PluginSecretStore::in_memory().unwrap();
    relayed_service(&store).await;
    let client = BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token");
    assert!(crate::vault::broker::serving().is_none());
    let error = plan_relay(
        &store,
        "lease-closed",
        &manager(),
        &BoxNetwork::Egress,
        600,
        &client,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("not running"), "{error}");
    // Nothing was minted for the Box.
    assert_eq!(live_box_sessions(&store, "lease-closed").await, 0);
}

#[tokio::test]
async fn recovering_or_parking_an_orphaned_lease_revokes_its_relay() {
    let harness = crate::server::session_box::tests::Harness::new().await;
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    let store = crate::plugin_secrets::global().unwrap();
    for (index, park) in [(3, false), (4, true)] {
        let lease = uuid::Uuid::new_v4().to_string();
        let workspace = WorkspaceId(format!("bx_{}", index.to_string().repeat(32)));
        harness
            .fake
            .add_box(&workspace.0, &format!("ryu-ct-{lease}"));
        {
            let conn = store.conn.lock().await;
            sessions::mint(
                &conn,
                sessions::MintRequest {
                    environment: "default".into(),
                    services: vec!["github".into()],
                    label: "Box".into(),
                    ttl_secs: None,
                    minted_by: box_relay::subject_for(&lease),
                    not_after: None,
                    minted_token: None,
                    minter_scope: None,
                },
            )
            .unwrap();
        }
        assert_eq!(live_box_sessions(store, &lease).await, 1);
        let handle = lease_handle(&lease, Some(&workspace));
        if park {
            park_lease(&lease, &handle).await.unwrap();
        } else {
            recover_lease(&lease, &handle).await.unwrap();
        }
        assert_eq!(live_box_sessions(store, &lease).await, 0, "park: {park}");
    }
}
