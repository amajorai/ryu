//! The credential tool rule: a tool its manifest marks as returning a stored
//! credential's value is refused, on every node and every tool plane, until the
//! node's owner names it in the allow list.
//!
//! No tool can reach a backend: every call carries an allowlist that does not
//! name the tool, so a call the rule lets through ends at the allowlist stop of
//! the app-tool arm. The allow list is bound per task, so no test changes the
//! list a concurrently running test reads. The list of the process, as the
//! setting loads it, is tested on the route (`server::mcp_tools`), by the one
//! test that writes the setting.

use super::*;
use crate::sidecar::control_plane::with_test_node_binding;
use crate::sidecar::mcp::node_user_fixtures::{
    admin, allowlist_without_the_tool, conversations_owned, dispatch, person, personal_node,
    registry_with_class_tools, seed_tool_policy_for, shared_node, ALLOWLIST_STOP, BROWSER_TOOL,
    CAPTURES_TOOL, CREDENTIAL_TOOL, PLAIN_TOOL, RETURNS_CREDENTIAL_TOOL,
};
use serde_json::json;

const ADMIN: &str = "ce36-cred-admin";
const OWNER: &str = "ce36-cred-owner";
const ADMIN_CHAT: &str = "ce36-cred-admin-chat";

async fn registry() -> McpRegistry {
    seed_tool_policy_for(&[ADMIN, OWNER]);
    let conversations = conversations_owned(&[(ADMIN_CHAT, ADMIN)]).await;
    registry_with_class_tools(Some(conversations)).await
}

fn nothing_allowed() -> Vec<String> {
    Vec::new()
}

#[track_caller]
fn assert_refused(answer: &str) {
    assert!(
        answer.contains(CREDENTIAL_TOOL_REFUSAL),
        "the rule refuses: {answer}"
    );
    assert!(
        answer.contains(CREDENTIAL_TOOLS_ALLOWED_PREF_KEY),
        "the setting is named: {answer}"
    );
    assert!(
        answer.contains(RETURNS_CREDENTIAL_TOOL),
        "the tool is named: {answer}"
    );
    assert!(!answer.contains(ALLOWLIST_STOP), "{answer}");
}

#[track_caller]
fn assert_reached_the_tool(answer: &str) {
    assert!(
        answer.contains(ALLOWLIST_STOP),
        "the call passes the rule and ends at the stop behind it: {answer}"
    );
    assert!(!answer.contains(CREDENTIAL_TOOL_REFUSAL), "{answer}");
}

fn text(result: Result<Value>) -> String {
    match result {
        Ok(value) => format!("THE CALL RAN: {value}"),
        Err(error) => error.to_string(),
    }
}

#[tokio::test]
async fn a_tool_that_returns_a_credential_is_refused_until_it_is_allowed_by_name() {
    let registry = registry().await;
    // A node bound to nothing and the owner's own personal node: the rule
    // holds on both, for a call with no person and for the owner's call.
    for node in [None, Some(personal_node(OWNER))] {
        with_test_node_binding(
            false,
            node,
            with_test_credential_tools_allowed(nothing_allowed(), async {
                let answer = dispatch(&registry, RETURNS_CREDENTIAL_TOOL, None).await;
                assert_refused(&answer);
                let owner = person(OWNER, crate::identity_verify::OrgRole::Owner);
                let answer = with_verified_tool_caller(
                    &owner,
                    dispatch(&registry, RETURNS_CREDENTIAL_TOOL, None),
                )
                .await;
                assert_refused(&answer);
            }),
        )
        .await;
    }
}

#[tokio::test]
async fn a_tool_that_returns_a_credential_is_refused_on_every_tool_plane() {
    let registry = registry().await;
    let allowlist = allowlist_without_the_tool();
    with_test_node_binding(
        false,
        None,
        with_test_credential_tools_allowed(nothing_allowed(), async {
            // The entry a workflow, a routine or a monitor takes: no gate.
            let ungated = text(
                registry
                    .call_tool(RETURNS_CREDENTIAL_TOOL, json!({}), Some(&allowlist))
                    .await,
            );
            assert_refused(&ungated);
            // The gated entry a turn takes: refused before anything is queued.
            let gated = text(
                registry
                    .call_tool_with_identity_scoped(
                        None,
                        RETURNS_CREDENTIAL_TOOL,
                        json!({}),
                        Some(&allowlist),
                        None,
                        &[],
                        None,
                        None,
                        None,
                        None,
                    )
                    .await,
            );
            assert_refused(&gated);
            // The entry an approved call is replayed through.
            let replayed = dispatch(&registry, RETURNS_CREDENTIAL_TOOL, None).await;
            assert_refused(&replayed);
        }),
    )
    .await;
}

#[tokio::test]
async fn managing_a_shared_node_does_not_allow_a_tool_that_returns_a_credential() {
    // The admin passes the node-user rule; the allow list is asked as well.
    let registry = registry().await;
    with_test_node_binding(
        false,
        Some(shared_node()),
        with_test_credential_tools_allowed(nothing_allowed(), async {
            let admin = admin(ADMIN);
            let answer = authenticated_scope::with_turn_sender(
                &admin,
                dispatch(&registry, RETURNS_CREDENTIAL_TOOL, Some(ADMIN_CHAT)),
            )
            .await;
            assert_refused(&answer);
        }),
    )
    .await;
}

#[test]
fn the_shipped_bitwarden_list_and_get_tools_declare_that_they_return_a_credential() {
    let bitwarden = crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .chain(crate::plugin_manifest::PluginManifestLoader::load_builtins())
        .find(|manifest| manifest.id == "@ryu/bitwarden")
        .expect("the Bitwarden app is compiled into Core");
    let marked = |slug: &str| {
        bitwarden
            .runnables
            .iter()
            .filter_map(|entry| entry.config.as_ref())
            .find(|config| config.get("slug").and_then(Value::as_str) == Some(slug))
            .unwrap_or_else(|| panic!("{slug} is a Bitwarden tool"))
            .get("returns_credential")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    // The two tools whose answer holds the secret's value.
    assert!(marked("bitwarden.list"));
    assert!(marked("bitwarden.get"));
    // Project names and the status are no credential.
    assert!(!marked("bitwarden.projects"));
    assert!(!marked("bitwarden.status"));
}

// Guards: these hold with the rule and without it.

#[tokio::test]
async fn an_allowed_credential_tool_is_not_refused() {
    let registry = registry().await;
    with_test_node_binding(
        false,
        None,
        with_test_credential_tools_allowed(vec![RETURNS_CREDENTIAL_TOOL.to_owned()], async {
            assert_reached_the_tool(&dispatch(&registry, RETURNS_CREDENTIAL_TOOL, None).await);
        }),
    )
    .await;
}

#[tokio::test]
async fn a_tool_without_the_mark_is_not_touched_by_the_allow_list() {
    let registry = registry().await;
    with_test_node_binding(
        false,
        None,
        with_test_credential_tools_allowed(nothing_allowed(), async {
            for tool in [PLAIN_TOOL, CREDENTIAL_TOOL, BROWSER_TOOL, CAPTURES_TOOL] {
                assert_reached_the_tool(&dispatch(&registry, tool, None).await);
            }
        }),
    )
    .await;
}

#[test]
fn the_allow_list_reads_only_a_json_array_of_exact_ids() {
    assert_eq!(
        parse_allowed(r#"["bitwarden.get"," bitwarden.list ",""]"#),
        vec!["bitwarden.get".to_owned(), "bitwarden.list".to_owned()]
    );
    // Anything else names nothing: no wildcard, no single string, no object.
    for value in [
        "",
        "*",
        "bitwarden.get",
        r#""bitwarden.get""#,
        r#"{"bitwarden.get":true}"#,
        r#"["bitwarden.get",1]"#,
        "null",
    ] {
        assert!(parse_allowed(value).is_empty(), "{value}");
    }
    // An entry is an exact id; a prefix or a pattern matches nothing.
    let allowed = parse_allowed(r#"["bitwarden.*","bitwarden"]"#);
    assert!(!allowed.iter().any(|id| id == "bitwarden.get"));
}
