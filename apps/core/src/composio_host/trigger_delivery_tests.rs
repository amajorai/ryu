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

mod subscriber {
    //! Regression tests: a legacy agent trigger fires only while the user who
    //! subscribed it may still run the agent on an organization-bound node.

    use crate::acl::store::{ResourceKey, StoredOverwrite};
    use crate::identity_verify::{permissions, OrgRole, VerifiedCaller};
    use crate::scheduler::agent_run_access::with_test_owner;
    use crate::sidecar::control_plane::{
        with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
    };
    use ryu_composio::ComposioHost;

    fn org_node() -> RegisteredNode {
        RegisteredNode {
            org: RegisteredOrg {
                id: "org1".to_owned(),
                name: "Org".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        }
    }

    fn member(user_id: &str, org_id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some(org_id.to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        }
    }

    fn unique_agent() -> String {
        format!("agent-trigger-{}", uuid::Uuid::new_v4().simple())
    }

    /// The host's answer for `subscriber` on `agent`, on an org-bound node
    /// where the control plane currently resolves `current` for that user.
    async fn bound_answer(current: VerifiedCaller, subscriber: &str, agent: &str) -> bool {
        with_test_node_binding(
            true,
            Some(org_node()),
            with_test_owner(
                current,
                super::super::CoreComposioHost.subscriber_may_run_agent(subscriber, agent),
            ),
        )
        .await
        .expect("the host answers")
    }

    #[tokio::test]
    async fn a_subscriber_denied_agent_run_no_longer_fires_the_agent() {
        let agent = unique_agent();
        let key = ResourceKey::new(crate::acl::KIND_AGENT, &agent);
        crate::acl::store::set_overwrites(
            &key,
            vec![StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: "u1".to_owned(),
                allow: Vec::new(),
                deny: vec![permissions::AGENT_RUN.to_owned()],
            }],
        )
        .expect("persist the ACL fixture");
        let denied = bound_answer(member("u1", "org1"), "u1", &agent).await;
        let _ = crate::acl::store::set_overwrites(&key, Vec::new());
        assert!(!denied, "a revoked subscriber must not start agent runs");
    }

    #[tokio::test]
    async fn a_subscriber_who_may_run_the_agent_still_fires_it() {
        let agent = unique_agent();
        assert!(bound_answer(member("u1", "org1"), "u1", &agent).await);
    }

    #[tokio::test]
    async fn a_removed_member_no_longer_fires_the_agent() {
        let agent = unique_agent();
        assert!(!bound_answer(member("u1", "other-org"), "u1", &agent).await);
        assert!(!bound_answer(member("someone-else", "org1"), "u1", &agent).await);
    }

    #[tokio::test]
    async fn a_row_without_a_subscriber_fires_only_on_an_unbound_node() {
        let agent = unique_agent();
        assert!(!bound_answer(member("u1", "org1"), "", &agent).await);
        let unbound = with_test_node_binding(
            false,
            None,
            super::super::CoreComposioHost.subscriber_may_run_agent("", &agent),
        )
        .await
        .expect("the host answers");
        assert!(unbound);
    }
}

mod workflow_subscriber {
    //! Regression tests: a legacy workflow trigger fires only while the user
    //! who subscribed it may still run the workflow, and a row with no
    //! recorded subscriber never fires on an organization-bound node.

    use crate::identity_verify::{OrgRole, VerifiedCaller};
    use crate::scheduler::agent_run_access::with_test_owner;
    use crate::sidecar::control_plane::{
        with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
    };
    use ryu_composio::ComposioHost;

    fn org_node() -> RegisteredNode {
        RegisteredNode {
            org: RegisteredOrg {
                id: "org1".to_owned(),
                name: "Org".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        }
    }

    fn member(user_id: &str, org_id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some(org_id.to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        }
    }

    fn unique_workflow() -> String {
        format!("wf-trigger-{}", uuid::Uuid::new_v4().simple())
    }

    async fn bound_answer(current: VerifiedCaller, subscriber: &str, workflow: &str) -> bool {
        with_test_node_binding(
            true,
            Some(org_node()),
            with_test_owner(
                current,
                super::super::CoreComposioHost.subscriber_may_run_workflow(
                    subscriber,
                    workflow,
                    "ca_victim",
                ),
            ),
        )
        .await
        .expect("the host answers")
    }

    #[tokio::test]
    async fn a_workflow_row_without_a_subscriber_fires_only_on_an_unbound_node() {
        let workflow = unique_workflow();
        assert!(!bound_answer(member("u1", "org1"), "", &workflow).await);
        let unbound = with_test_node_binding(
            false,
            None,
            super::super::CoreComposioHost.subscriber_may_run_workflow("", &workflow, "ca_1"),
        )
        .await
        .expect("the host answers");
        assert!(unbound);
    }

    #[tokio::test]
    async fn a_removed_member_no_longer_fires_the_workflow() {
        let workflow = unique_workflow();
        assert!(!bound_answer(member("u1", "other-org"), "u1", &workflow).await);
        assert!(!bound_answer(member("someone-else", "org1"), "u1", &workflow).await);
    }
}
