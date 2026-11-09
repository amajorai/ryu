//! Paired-device grants never reach owner-only preference or support routes.

use super::*;

/// Paired-client records added for one test and removed when it ends, even on
/// failure, so the process paired-client store is conserved for other tests.
struct PairedGrants {
    ids: Vec<String>,
}

impl PairedGrants {
    fn add(
        &mut self,
        label: &str,
        scopes: CapabilitySet,
        expires_at: Option<u64>,
        revoked_at: Option<u64>,
    ) -> String {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let token = format!("ryup_core_policy_{label}_{suffix}");
        let id = format!("pc_core_policy_{label}_{suffix}");
        let mut clients = crate::pairing::load_paired_clients();
        clients.clients.push(crate::pairing::PairedClient {
            schema_version: crate::pairing::PAIRED_CLIENT_SCHEMA_VERSION,
            id: id.clone(),
            name: format!("core-policy {label}"),
            token_sha256: crate::pairing::hash_token(&token),
            created_at: crate::pairing::now_secs().saturating_sub(10),
            last_seen: 0,
            granted_scopes: scopes,
            constraints: GrantConstraints::default(),
            expires_at,
            revoked_at,
        });
        crate::pairing::save_paired_clients(&clients).unwrap();
        self.ids.push(id);
        token
    }
}

impl Drop for PairedGrants {
    fn drop(&mut self) {
        let mut clients = crate::pairing::load_paired_clients();
        clients
            .clients
            .retain(|client| !self.ids.contains(&client.id));
        let _ = crate::pairing::save_paired_clients(&clients);
    }
}

const EVERY_CAPABILITY: [Capability; 16] = [
    Capability::ChatRead,
    Capability::ChatWrite,
    Capability::AgentsRead,
    Capability::AgentsManage,
    Capability::WorkflowsRead,
    Capability::WorkflowsRun,
    Capability::WorkflowsManage,
    Capability::ToolsRead,
    Capability::ToolsExec,
    Capability::MemoryRead,
    Capability::MemoryWrite,
    Capability::GatewayRoute,
    Capability::NodeSandboxRead,
    Capability::VaultWrite,
    Capability::FilesRead,
    Capability::FilesWrite,
];

#[tokio::test]
async fn paired_credentials_never_reach_owner_only_preference_or_support_routes() {
    let harness = Harness::new(Some(OWNER));
    let (theme, consent) = seed(&harness).await;
    let personalization = crate::server::onboarding_state::USER_PERSONALIZATION_PREF_KEY;
    let profile = r#"{"displayName":"Ada"}"#;
    assert_eq!(
        harness
            .put(personalization, profile, Credential::Bearer(OWNER))
            .await
            .status,
        StatusCode::OK
    );
    let personalization_record = harness.raw_record(personalization).unwrap();
    let mut events = harness.state.preferences.subscribe();

    let now = crate::pairing::now_secs();
    let mut grants = PairedGrants { ids: Vec::new() };
    let everything = grants.add(
        "everything",
        CapabilitySet::new(EVERY_CAPABILITY),
        None,
        None,
    );
    let routing_only = grants.add(
        "routing",
        CapabilitySet::new([Capability::GatewayRoute]),
        None,
        None,
    );
    let without_routing = grants.add(
        "no_routing",
        CapabilitySet::new(
            EVERY_CAPABILITY
                .into_iter()
                .filter(|capability| *capability != Capability::GatewayRoute),
        ),
        None,
        None,
    );
    let revoked = grants.add(
        "revoked",
        CapabilitySet::new(EVERY_CAPABILITY),
        None,
        Some(now.saturating_sub(1)),
    );
    let expired = grants.add(
        "expired",
        CapabilitySet::new(EVERY_CAPABILITY),
        Some(now.saturating_sub(1)),
        None,
    );

    // A live paired grant is authenticated but never owner: no capability
    // combination reaches these owner-only routes.
    for token in [&everything, &routing_only, &without_routing] {
        harness
            .assert_every_route_refuses(Credential::Bearer(token), StatusCode::FORBIDDEN)
            .await;
    }
    // A revoked or expired grant is indistinguishable from an unknown token.
    for token in [&revoked, &expired] {
        harness
            .assert_every_route_refuses(Credential::Bearer(token), StatusCode::UNAUTHORIZED)
            .await;
    }

    // The personalization note feeds every owner chat turn, so the route
    // policy keeps it owner-or-member-session only: even a `gateway:route`
    // grant is refused before the handler (remote_auth credential policy).
    assert_eq!(
        harness
            .get(personalization, Credential::Bearer(&routing_only))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let refused = harness
        .put(personalization, "{}", Credential::Bearer(&without_routing))
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert_eq!(
        harness
            .get(personalization, Credential::Bearer(&without_routing))
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    no_event(&mut events);
    assert_eq!(harness.raw_record("theme").unwrap(), theme);
    assert_eq!(
        harness
            .raw_record(crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY)
            .unwrap(),
        consent
    );
    assert_eq!(
        harness.raw_record(personalization).unwrap(),
        personalization_record
    );
    assert_eq!(
        harness.raw_record(crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY),
        None,
        "a paired client must not open the support channel"
    );
    assert!(harness.audit_rows().await.is_empty());
    assert_eq!(
        harness.audit(Credential::Bearer(OWNER)).await.json(),
        json!({ "entries": [] })
    );
}
