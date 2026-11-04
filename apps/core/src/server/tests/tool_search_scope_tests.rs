use crate::agents::{AgentStore, CreateAgent};
use crate::server::agent_skill_allowlist;
use crate::sidecar::adapters::AcpAgentRegistry;

/// Build a `CreateAgent` through serde: the struct has no `Default` and every
/// field but `name` is `#[serde(default)]`, so this is the supported way to
/// name only the field under test.
fn new_agent(name: &str, skills: &[&str]) -> CreateAgent {
    serde_json::from_value(serde_json::json!({ "name": name, "skills": skills }))
        .expect("CreateAgent literal")
}

#[tokio::test]
async fn the_search_scope_is_the_agents_own_skill_list_not_its_tool_list() {
    let registry = AcpAgentRegistry::new();
    let store = AgentStore::open_in_memory(&registry).expect("in-memory agent store");
    let scoped = store
        .create(new_agent("scoped", &["pdf", "xlsx"]))
        .await
        .expect("create scoped agent");
    let unscoped = store
        .create(new_agent("unscoped", &[]))
        .await
        .expect("create unscoped agent");

    // The scoped agent's own two skills — the value threaded into
    // `search_scoped`, which is what keeps `tool_search` from listing every
    // enabled skill on the node to an agent that was given two.
    assert_eq!(
        agent_skill_allowlist(&store, Some(&scoped.id)).await,
        vec!["pdf".to_owned(), "xlsx".to_owned()]
    );

    // An agent that was deliberately given no allowlist keeps seeing all of
    // them: empty means "every enabled skill", so this is the same answer as
    // the agent-less default and NOT a denial.
    assert!(agent_skill_allowlist(&store, Some(&unscoped.id))
        .await
        .is_empty());

    // Degraded paths fail open, both of them.
    assert!(agent_skill_allowlist(&store, None).await.is_empty());
    assert!(agent_skill_allowlist(&store, Some("agent_does_not_exist"))
        .await
        .is_empty());

    // The two lists are not interchangeable: the env-derived TOOL allowlist
    // this handler also consults knows nothing about these skills. Pinned so a
    // future "simplification" that collapses them fails here.
    assert!(
        registry.allowlist_for(&scoped.id).is_none(),
        "no RYU_MCP_ALLOWLIST* is set in this test process, so the tool \
             allowlist narrows nothing — it could never have scoped the skills"
    );
}
