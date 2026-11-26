//! People, nodes and a registry the suites of the node-user rule share.
//!
//! No tool here can reach a backend. Every call of these suites carries an
//! allowlist that does not name the tool, so a call the rule lets through ends
//! at the app-tool arm with [`ALLOWLIST_STOP`], before anything is started and
//! before any request is sent. The backends are made up as well: a binary key
//! that no allowlist holds and hosts under `.invalid`, with no grant.

use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::plugin_manifest::schema::RunnableEntry;
use crate::plugin_manifest::{PluginManifest, ProviderTarget, ProvidesEntry};
use crate::runnable::RunnableKind;
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};
use crate::sidecar::mcp::{AppToolBackendTag, McpRegistry};
use serde_json::json;

pub(crate) const ORG: &str = "org_ce36";

/// A command tool whose child is handed a saved key.
pub(crate) const CREDENTIAL_TOOL: &str = "app.cesecret";
/// A tool of an app that provides `browser.control` on this machine.
pub(crate) const BROWSER_TOOL: &str = "app.cebrowser";
/// A tool that reads Core's desktop-capture API.
pub(crate) const CAPTURES_TOOL: &str = "app.cecapture";
/// A tool its manifest marks as returning a stored credential's value.
pub(crate) const RETURNS_CREDENTIAL_TOOL: &str = "app.cevalue";
/// A tool in no class.
pub(crate) const PLAIN_TOOL: &str = "app.ceplain";

/// What a call answers when the rule let it through: the stop behind the rule.
pub(crate) const ALLOWLIST_STOP: &str = "is not in this agent's allowlist";

pub(crate) fn person(user_id: &str, role: OrgRole) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(ORG.to_owned()),
        role,
        teams: Vec::new(),
    }
}

pub(crate) fn member(user_id: &str) -> VerifiedCaller {
    person(user_id, OrgRole::Member)
}

pub(crate) fn admin(user_id: &str) -> VerifiedCaller {
    person(user_id, OrgRole::Admin)
}

fn node(scope: NodeScope, owner_user_id: Option<&str>) -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: ORG.to_owned(),
            name: "CE-36".to_owned(),
            slug: None,
        },
        node_id: "node_ce36".to_owned(),
        scope,
        team_id: None,
        owner_user_id: owner_user_id.map(str::to_owned),
    }
}

/// A registered Org node: it bounds its members.
pub(crate) fn shared_node() -> RegisteredNode {
    node(NodeScope::Org, None)
}

/// A registered personal node of `owner`, which is never bounded.
pub(crate) fn personal_node(owner: &str) -> RegisteredNode {
    node(NodeScope::Personal, Some(owner))
}

/// Let the organization's tool policy answer for these people from its cache,
/// with rules that allow everything. Without it the policy, which runs in front
/// of the rule, would ask the control plane about a person it has not seen.
pub(crate) fn seed_tool_policy_for(users: &[&str]) {
    for user in users {
        crate::org_policy::seed_caller_tool_rules_for_tests(
            ORG,
            None,
            user,
            crate::org_policy::OrgToolRules::default(),
        );
    }
}

/// A conversation store holding one conversation per `(id, owner)` pair.
pub(crate) async fn conversations_owned(owned: &[(&str, &str)]) -> ConversationStore {
    let store = ConversationStore::open_in_memory().expect("open the conversation store");
    for (conversation, owner) in owned {
        store
            .ensure_conversation(
                conversation,
                None,
                None,
                Tenancy::Owned {
                    user_id: (*owner).to_owned(),
                    org_id: Some(ORG.to_owned()),
                },
            )
            .await
            .expect("store the conversation");
    }
    store
}

fn tool(slug: &str, config: serde_json::Value) -> RunnableEntry {
    RunnableEntry {
        id: slug.to_owned(),
        name: slug.to_owned(),
        kind: RunnableKind::Tool,
        config: Some(config),
    }
}

fn app(id: &str, runnables: Vec<RunnableEntry>, provides: Vec<ProvidesEntry>) -> PluginManifest {
    PluginManifest {
        id: id.to_owned(),
        name: "CE-36 test app".to_owned(),
        version: "1.0.0".to_owned(),
        runnables,
        provides,
        companion: None,
        ..Default::default()
    }
}

/// The test apps: one per class, one whose tool is marked as returning a
/// credential, and one in no class.
pub(crate) fn class_apps() -> Vec<PluginManifest> {
    vec![
        app(
            "com.test.ce36.credential",
            vec![tool(
                "cesecret",
                json!({
                    "slug": "cesecret",
                    "backend": "command",
                    "bin": "ce36-no-such-bin",
                    "command_args": [],
                    "command_env": { "CE36_TOKEN": "secret:ce36-test-token" },
                }),
            )],
            Vec::new(),
        ),
        app(
            "com.test.ce36.browser",
            vec![tool(
                "cebrowser",
                json!({
                    "slug": "cebrowser",
                    "backend": "http",
                    "url": "https://ce36.invalid/page",
                }),
            )],
            vec![ProvidesEntry {
                capability: "browser.control".to_owned(),
                version: "1.0.0".to_owned(),
                target: Some(ProviderTarget::LocalMachine),
                ..Default::default()
            }],
        ),
        app(
            "com.test.ce36.captures",
            vec![tool(
                "cecapture",
                json!({
                    "slug": "cecapture",
                    "backend": "http",
                    "method": "GET",
                    "url": "core:/api/shadow/search",
                }),
            )],
            Vec::new(),
        ),
        app(
            "com.test.ce36.value",
            vec![tool(
                "cevalue",
                json!({
                    "slug": "cevalue",
                    "backend": "http",
                    "url": "https://ce36.invalid/value",
                    "returns_credential": true,
                }),
            )],
            Vec::new(),
        ),
        app(
            "com.test.ce36.plain",
            vec![tool(
                "ceplain",
                json!({
                    "slug": "ceplain",
                    "backend": "http",
                    "url": "https://ce36.invalid/plain",
                }),
            )],
            Vec::new(),
        ),
    ]
}

/// A registry with the test apps enabled and their tools registered, wired the
/// way production wires live manifests (`with_self_build`).
pub(crate) async fn registry_with_class_tools(
    conversations: Option<ConversationStore>,
) -> McpRegistry {
    let manifests = class_apps();
    let store = std::sync::Arc::new(
        crate::plugins::PluginStore::open_in_memory().expect("open the app store"),
    );
    let no_grants: Vec<String> = Vec::new();
    for manifest in &manifests {
        store
            .insert(&manifest.id, "1.0.0")
            .await
            .expect("store the app");
        store
            .set_enabled(&manifest.id, &no_grants)
            .await
            .expect("enable the app");
    }
    let registry = McpRegistry::empty().with_self_build(
        std::sync::Arc::new(tokio::sync::RwLock::new(manifests)),
        store,
    );
    let registry = match conversations {
        Some(conversations) => registry.with_conversations(conversations),
        None => registry,
    };
    registry.register_app_tool_tagged(
        CREDENTIAL_TOOL.to_owned(),
        "cesecret".to_owned(),
        None,
        Some(AppToolBackendTag::Command),
    );
    for (id, slug) in [
        (BROWSER_TOOL, "cebrowser"),
        (CAPTURES_TOOL, "cecapture"),
        (RETURNS_CREDENTIAL_TOOL, "cevalue"),
        (PLAIN_TOOL, "ceplain"),
    ] {
        registry.register_app_tool(id.to_owned(), slug.to_owned(), None);
    }
    registry
}

/// An allowlist that names none of the test tools.
pub(crate) fn allowlist_without_the_tool() -> Vec<String> {
    vec!["ce36.nothing".to_owned()]
}

/// One call through the entry an approved or internal call takes, which ends
/// in the dispatch core with no approval gate in front. Returns the error text,
/// or a sentence that no assertion of these suites accepts if the call ran.
pub(crate) async fn dispatch(
    registry: &McpRegistry,
    tool: &str,
    conversation: Option<&str>,
) -> String {
    let allowlist = allowlist_without_the_tool();
    match registry
        .call_tool_with_identity_after_approval_scoped(
            None,
            tool,
            json!({}),
            Some(&allowlist),
            None,
            &[],
            None,
            conversation,
            None,
            None,
            false,
        )
        .await
    {
        Ok(value) => format!("THE CALL RAN: {value}"),
        Err(error) => error.to_string(),
    }
}
