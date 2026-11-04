use crate::agents::{AgentIdentityMode, AgentStore};
use crate::plugin_manifest::schema::RunnableEntry;
use crate::runnable::RunnableKind;
use crate::server::{build_runnable_registry_from_parts, manifest_agent_create};
use serde_json::json;

fn agent(id: &str, config: Option<serde_json::Value>) -> RunnableEntry {
    RunnableEntry {
        id: id.to_owned(),
        name: "Researcher".to_owned(),
        kind: RunnableKind::Agent,
        config,
    }
}

#[test]
fn a_manifest_without_identity_mode_still_acts_as_the_user() {
    for config in [None, Some(json!({ "system_prompt": "You research." }))] {
        let create = manifest_agent_create(&agent("a", config)).unwrap();
        assert_eq!(create.identity_mode, AgentIdentityMode::Managed);
        assert_eq!(create.account_access, None);
    }
}

#[test]
fn a_declared_identity_mode_is_applied_without_any_account_access() {
    for (wire, mode) in [
        ("managed", AgentIdentityMode::Managed),
        ("individual", AgentIdentityMode::Individual),
        ("mixed", AgentIdentityMode::Mixed),
    ] {
        let create = manifest_agent_create(&agent(
            "a",
            Some(json!({ "system_prompt": "You research.", "identity_mode": wire })),
        ))
        .unwrap();
        assert_eq!(create.identity_mode, mode);
        assert_eq!(create.account_access, None, "an app never sets accounts");
        assert_eq!(create.system_prompt.as_deref(), Some("You research."));
    }
}

#[test]
fn an_unknown_mode_or_an_app_supplied_allowlist_is_refused_not_defaulted() {
    for config in [
        json!({ "identity_mode": "owner" }),
        json!({ "identity_mode": "" }),
        json!({ "identity_mode": 1 }),
        json!({ "identity_mode": "individual", "account_access": [] }),
        json!({ "account_access": ["platform:treg"] }),
        json!({ "account_access": null }),
    ] {
        assert!(
            manifest_agent_create(&agent("a", Some(config.clone()))).is_err(),
            "{config} must not materialize"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enabling_an_app_creates_its_agent_with_the_declared_mode() {
    let agents = AgentStore::open_in_memory(&crate::server::AcpAgentRegistry::new()).unwrap();
    let mcp = std::sync::Arc::new(crate::server::McpRegistry::empty());
    let skills = crate::server::SkillRegistry::empty();
    let contributions = crate::plugins::app_contrib::AppContribRegistry::default();
    let registry = build_runnable_registry_from_parts(&agents, &mcp, &skills, &contributions);
    let mut manifest = crate::plugin_manifest::PluginManifest::parse_and_validate(
        &json!({
            "id": "com.example.identity",
            "name": "Identity",
            "version": "1.0.0",
            "runnables": [
                { "id": "own", "name": "Own", "kind": "agent",
                  "config": { "identity_mode": "individual" } },
                { "id": "legacy", "name": "Legacy", "kind": "agent",
                  "config": { "system_prompt": "Old." } }
            ]
        })
        .to_string(),
    )
    .unwrap();
    for (_, result) in registry.register_all(&manifest) {
        result.unwrap();
    }
    let own = agents.get("app__own").await.unwrap().unwrap();
    assert_eq!(own.identity_mode, AgentIdentityMode::Individual);
    assert_eq!(own.account_access, None);
    let legacy = agents.get("app__legacy").await.unwrap().unwrap();
    assert_eq!(legacy.identity_mode, AgentIdentityMode::Managed);
    assert_eq!(legacy.account_access, None);

    // The user's own mode is never replaced by a new version, and an
    // existing agent keeps its account allowlist.
    agents
        .update(
            "app__own",
            crate::agents::UpdateAgent {
                identity_mode: Some(AgentIdentityMode::Managed),
                account_access: Some(Some(vec!["composio:ca_1".to_owned()])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // A new version: `own` asks for `mixed`, narrower than the `managed` the
    // user chose, and `legacy` (still on its app's mode) narrows to `individual`.
    manifest.runnables[0].config = Some(json!({ "identity_mode": "mixed" }));
    manifest.runnables[1].config = Some(json!({ "identity_mode": "individual" }));
    for (_, result) in registry.register_all(&manifest) {
        result.unwrap();
    }
    let own = agents.get("app__own").await.unwrap().unwrap();
    assert_eq!(own.identity_mode, AgentIdentityMode::Managed);
    assert_eq!(
        agents
            .app_identity("app__own")
            .await
            .unwrap()
            .unwrap()
            .pending_mode,
        Some(AgentIdentityMode::Mixed)
    );
    assert_eq!(own.account_access, Some(vec!["composio:ca_1".to_owned()]));
    let legacy = agents.get("app__legacy").await.unwrap().unwrap();
    assert_eq!(legacy.identity_mode, AgentIdentityMode::Individual);

    // A version that widens `legacy` again is only reported, never applied.
    manifest.runnables[0].config = Some(json!({ "identity_mode": "individual" }));
    manifest.runnables[1].config = Some(json!({ "identity_mode": "managed" }));
    let changes = crate::server::reconcile_app_agent_identities(&agents, &manifest).await;
    assert_eq!(
        changes,
        vec![json!({
            "agent_id": "app__legacy",
            "status": "pending",
            "identity_mode": "individual",
            "pending_identity_mode": "managed",
        })]
    );
    let legacy = agents.get("app__legacy").await.unwrap().unwrap();
    assert_eq!(legacy.identity_mode, AgentIdentityMode::Individual);
    assert_eq!(
        agents
            .app_identity("app__legacy")
            .await
            .unwrap()
            .unwrap()
            .pending_mode,
        Some(AgentIdentityMode::Managed)
    );
}

#[test]
fn an_update_keeps_only_the_agents_the_new_version_still_declares() {
    let manifest = |runnables: serde_json::Value| {
        crate::plugin_manifest::PluginManifest::parse_and_validate(
            &json!({
                "id": "com.example.keep",
                "name": "Keep",
                "version": "1.0.0",
                "runnables": runnables,
            })
            .to_string(),
        )
        .unwrap()
    };
    let old = manifest(json!([
        { "id": "stays", "name": "Stays", "kind": "agent" },
        { "id": "goes", "name": "Goes", "kind": "agent" }
    ]));
    let new = manifest(json!([
        { "id": "stays", "name": "Stays", "kind": "agent",
          "config": { "identity_mode": "individual" } },
        { "id": "fresh", "name": "Fresh", "kind": "agent" }
    ]));
    let kept = crate::server::app_agents_kept_by_update(&old, &new);
    assert_eq!(kept, ["stays".to_owned()].into_iter().collect());
}
