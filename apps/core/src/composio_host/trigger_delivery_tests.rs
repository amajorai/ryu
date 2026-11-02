use super::agent_may_receive_from;
use crate::agents::{AgentIdentityMode, AgentStore, CreateAgent};
use crate::sidecar::adapters::AcpAgentRegistry;

async fn record(
    store: &AgentStore,
    mode: AgentIdentityMode,
    access: Option<Vec<&str>>,
) -> crate::agents::AgentRecord {
    store
        .create(CreateAgent {
            name: format!("{mode:?} agent"),
            identity_mode: mode,
            account_access: access.map(|keys| keys.into_iter().map(str::to_owned).collect()),
            ..Default::default()
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn deliveries_follow_the_recorded_account_entity() {
    let store = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let mixed = record(
        &store,
        AgentIdentityMode::Mixed,
        Some(vec!["composio:ca_user", "agent-composio:own_1"]),
    )
    .await;
    let own = format!("agent:local:{}", mixed.id);

    // A user account follows the user-account allowlist.
    assert!(agent_may_receive_from(
        Some(&mixed),
        &mixed.id,
        "ca_user",
        ""
    ));
    assert!(!agent_may_receive_from(
        Some(&mixed),
        &mixed.id,
        "own_1",
        ""
    ));
    // An agent without a record keeps today's behaviour for user accounts...
    assert!(agent_may_receive_from(None, "gone", "ca_user", ""));
    // ...but never fires an own-entity account.
    assert!(!agent_may_receive_from(
        None,
        "gone",
        "own_1",
        "agent:local:gone"
    ));

    // An own account follows the own-account allowlist, on its own entity.
    assert!(agent_may_receive_from(
        Some(&mixed),
        &mixed.id,
        "own_1",
        &own
    ));
    assert!(!agent_may_receive_from(
        Some(&mixed),
        &mixed.id,
        "own_2",
        &own
    ));
    assert!(!agent_may_receive_from(
        Some(&mixed),
        &mixed.id,
        "ca_user",
        &own
    ));
    // Another agent's entity never matches, even with an allowed account.
    assert!(!agent_may_receive_from(
        Some(&mixed),
        &mixed.id,
        "own_1",
        "agent:local:other-agent"
    ));

    // An agent that acts as you never receives own-entity events.
    let legacy = record(&store, AgentIdentityMode::Managed, None).await;
    let legacy_entity = format!("agent:local:{}", legacy.id);
    assert!(!agent_may_receive_from(
        Some(&legacy),
        &legacy.id,
        "own_1",
        &legacy_entity
    ));
    assert!(agent_may_receive_from(
        Some(&legacy),
        &legacy.id,
        "ca_user",
        ""
    ));
}
