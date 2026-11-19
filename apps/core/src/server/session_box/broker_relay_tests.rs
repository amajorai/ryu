//! The broker relay in a chat-started session Box: no relay without marked
//! services, failing closed before anything is minted, and revocation.

use super::*;
use crate::vault::broker::{services, sessions};

fn manager() -> BoxRelayOwner {
    BoxRelayOwner {
        subjects: Vec::new(),
        manager: true,
    }
}

fn nobody() -> BoxRelayOwner {
    BoxRelayOwner {
        subjects: vec!["user:someone".to_owned()],
        manager: false,
    }
}

async fn relayed_service(store: &PluginSecretStore) {
    let mut input = services::test_service("github", "api.github.com", None, "/");
    input.environment = crate::vault::active_environment();
    input.box_relay = true;
    let conn = store.conn.lock().await;
    services::insert(&conn, input.normalize().unwrap()).unwrap();
}

async fn live_sessions(store: &PluginSecretStore, lease: &str) -> usize {
    let conn = store.conn.lock().await;
    sessions::list(&conn)
        .unwrap()
        .iter()
        .filter(|session| {
            session.minted_by == box_relay::subject_for(lease) && session.revoked_at.is_none()
        })
        .count()
}

/// A Box service nothing may be asked of.
fn unreachable_client() -> BoxSessionClient {
    BoxSessionClient::with_endpoint("http://127.0.0.1:9/v1", "box_token")
}

#[test]
fn a_relay_without_its_prerequisites_is_refused_plainly() {
    let url = Some("https://node.example.com/api/vault/broker/box-relay");
    assert!(refusal(false, url, true).unwrap().contains("not running"));
    assert!(refusal(true, None, true)
        .unwrap()
        .contains("public https URL"));
    assert!(refusal(true, url, false).unwrap().contains("cannot relay"));
    assert_eq!(refusal(true, url, true), None);
    let error = relay_error(refusal(false, url, true).unwrap());
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert_eq!(
        error.1 .0["error"]["code"],
        "session_box_broker_relay_unavailable"
    );
}

#[tokio::test]
async fn a_session_box_without_relay_services_is_created_as_before() {
    let store = PluginSecretStore::in_memory().unwrap();
    let client = unreachable_client();
    let planned = plan_relay(&store, "sb-lease-none", &manager(), &client)
        .await
        .unwrap();
    assert!(planned.is_none());
    // A marked service the caller holds no `use` on does not qualify either.
    relayed_service(&store).await;
    let planned = plan_relay(&store, "sb-lease-none", &nobody(), &client)
        .await
        .unwrap();
    assert!(planned.is_none());
    assert_eq!(live_sessions(&store, "sb-lease-none").await, 0);
}

#[tokio::test]
async fn a_session_box_that_would_get_relay_services_fails_closed_without_the_broker() {
    let store = PluginSecretStore::in_memory().unwrap();
    relayed_service(&store).await;
    assert!(crate::vault::broker::serving().is_none());
    let error = plan_relay(&store, "sb-lease-closed", &manager(), &unreachable_client())
        .await
        .unwrap_err();
    assert_eq!(error.0, StatusCode::CONFLICT);
    let message = error.1 .0["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("not running"), "{message}");
    assert_eq!(live_sessions(&store, "sb-lease-closed").await, 0);
}

// ── Wiring into session Box create and delete ───────────────────────────────

static TEST_STORE: std::sync::RwLock<Option<&'static PluginSecretStore>> =
    std::sync::RwLock::new(None);

pub(super) fn test_store() -> Option<&'static PluginSecretStore> {
    *TEST_STORE
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Relay sessions of session Boxes go to `store` while this lives. Install it
/// only under the session Box test [`Harness`], which serializes Box tests.
struct StoreOverride;

impl StoreOverride {
    fn install(store: &'static PluginSecretStore) -> Self {
        *TEST_STORE
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(store);
        Self
    }
}

impl Drop for StoreOverride {
    fn drop(&mut self) {
        *TEST_STORE
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}

use super::super::tests::{local_owner, Harness};

fn leaked_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

#[tokio::test]
async fn a_chat_session_box_that_would_get_relay_services_is_never_created_without_the_broker() {
    let harness = Harness::new().await;
    let store = leaked_store();
    relayed_service(store).await;
    let _override = StoreOverride::install(store);
    let conversation = format!("relay-closed-{}", uuid::Uuid::new_v4().simple());
    let key = SessionBoxKey::session("node-owner", &conversation);

    let error = desktop_target(&local_owner(), &key, Some(AcquireReason::ComputerUse))
        .await
        .unwrap_err();
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert_eq!(
        error.1 .0["error"]["code"],
        "session_box_broker_relay_unavailable"
    );
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
    assert!(existing_slot(&key).is_none());
    assert!(leases()
        .iter()
        .all(|lease| lease.conversation_id != conversation));
}

#[tokio::test]
async fn a_chat_session_box_relay_session_ends_when_the_conversation_is_deleted() {
    let harness = Harness::new().await;
    let store = leaked_store();
    let _override = StoreOverride::install(store);
    let conversation = format!("relay-delete-{}", uuid::Uuid::new_v4().simple());
    let key = SessionBoxKey::session("node-owner", &conversation);

    // No marked service: the Box is created as before, without a relay.
    let target = desktop_target(&local_owner(), &key, Some(AcquireReason::ComputerUse))
        .await
        .unwrap()
        .expect("a session Box");
    let creates = harness.fake.matching("POST", "/v1/boxes");
    assert_eq!(creates.len(), 1);
    assert!(creates[0].body.get("brokerRelay").is_none());

    // A relay session of this Box's lease is revoked with its Box.
    relayed_service(store).await;
    let minted = box_relay::mint(store, &target.lease_id, &manager(), 600, &admits_any)
        .await
        .unwrap();
    assert!(minted.is_some());
    assert_eq!(live_sessions(store, &target.lease_id).await, 1);
    release_conversation("node-owner", &conversation).await;
    assert_eq!(live_sessions(store, &target.lease_id).await, 0);
}
