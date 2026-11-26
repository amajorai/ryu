//! Tests of the folder boundary for turns on a shared node.
//!
//! `rule` covers the rule itself, `turns` sends turns through
//! `route_chat_stream`, the one path every turn takes, and `routes` calls the
//! HTTP handlers. The node kind and the member folders come from per-task test
//! seams, so no test changes what a concurrently running test reads.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::server::ServerState;
use crate::sidecar::control_plane::{with_test_node_binding, RegisteredNode, RegisteredOrg};

mod routes;
mod rule;
mod turns;

const ORG: &str = "org1";
const MEMBER: &str = "member-1";

fn node(scope: NodeScope) -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: ORG.to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope,
        team_id: None,
        owner_user_id: (scope == NodeScope::Personal).then(|| "owner-1".to_owned()),
    }
}

fn person(user_id: &str, role: OrgRole) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(ORG.to_owned()),
        role,
        teams: Vec::new(),
    })
}

fn member() -> Option<VerifiedCaller> {
    person(MEMBER, OrgRole::Member)
}

/// The preference value that lists `dirs`.
fn list_value(dirs: &[&Path]) -> String {
    serde_json::Value::Array(
        dirs.iter()
            .map(|dir| json!({ "path": dir.to_string_lossy() }))
            .collect(),
    )
    .to_string()
}

/// The member folders as the preference parser reads them, so every bounded
/// test also runs the real parser.
fn roots_of(dirs: &[&Path]) -> Vec<PathBuf> {
    let value = list_value(dirs);
    let roots = parse_member_roots(&value);
    assert_eq!(
        roots.len(),
        dirs.len(),
        "every test folder must be a usable member folder: {value}"
    );
    roots
}

/// Run `fut` on a shared node (registered, scope Org) whose member folders are `dirs`.
async fn on_shared_node<F: Future>(dirs: &[&Path], fut: F) -> F::Output {
    with_test_node_binding(
        true,
        Some(node(NodeScope::Org)),
        with_test_member_roots(roots_of(dirs), fut),
    )
    .await
}

/// The resolved form of an existing path, as the boundary hands it on.
fn real(path: &Path) -> String {
    text(plain(std::fs::canonicalize(path).expect("canonical")))
}

/// One server state for the whole test process (a second one locks the database).
fn state() -> ServerState {
    static STATE: OnceLock<(tempfile::TempDir, ServerState)> = OnceLock::new();
    STATE
        .get_or_init(|| {
            crate::crypto_host::install();
            let directory = tempfile::tempdir().expect("data");
            let state = crate::server::isolated_plugin_hook_test_state(directory.path());
            (directory, state)
        })
        .1
        .clone()
}

fn conversation(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

/// A conversation the member owns, with one user turn. Returns the turn's id.
async fn owned_conversation(store: &ConversationStore, id: &str) -> String {
    store
        .ensure_conversation(
            id,
            None,
            None,
            Tenancy::Owned {
                user_id: MEMBER.to_owned(),
                org_id: Some(ORG.to_owned()),
            },
        )
        .await
        .expect("conversation");
    store
        .append_message(id, "user", "change the file", None, None, None)
        .await
        .expect("user turn")
}

/// A persisted user turn with the given folder fields merged in.
fn turn(conversation_id: &str, folders: serde_json::Value) -> ChatStreamRequest {
    let mut body = json!({
        "conversation_id": conversation_id,
        "messages": [{ "role": "user", "parts": [{ "type": "text", "text": "hello" }] }],
        "enable_long_term": false,
        "persist": true,
    });
    if let (Some(body), Some(folders)) = (body.as_object_mut(), folders.as_object()) {
        body.extend(folders.clone());
    }
    serde_json::from_value(body).expect("request")
}

/// Send a turn the way every producer does, through `route_chat_stream`.
async fn send(store: &ConversationStore, request: ChatStreamRequest) -> axum::response::Response {
    use crate::sidecar::adapters::{acp::AcpAgentRegistry, route_chat_stream};
    route_chat_stream(
        request,
        std::sync::Arc::new(AcpAgentRegistry::new()),
        store.clone(),
        crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).expect("agents"),
        crate::sidecar::SidecarManager::new_noop(),
        crate::server::memory::MemoryStore::open_in_memory().expect("memory"),
        std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        std::sync::Arc::new(crate::sidecar::mcp::McpRegistry::empty()),
        ryu_skills::SkillRegistry::empty(),
        ryu_tracing::TraceStore::open_in_memory().expect("traces"),
        None,
        None,
        crate::routing_policy::reactive::TurnWatch::off(),
        None,
    )
    .await
}

/// The body of a response as text. A refusal is a finished body of known size.
/// A turn that was admitted answers with a live stream; that stream is never
/// read here, so no test drives a turn as far as a model call.
async fn body_text(response: axum::response::Response) -> String {
    use axum::body::HttpBody as _;
    if response.body().size_hint().exact().is_none() {
        return String::new();
    }
    let read = axum::body::to_bytes(response.into_body(), 1024 * 1024);
    match tokio::time::timeout(Duration::from_secs(5), read).await {
        Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => String::new(),
    }
}

/// What a turn left on the conversation row: the stored folder and worktree.
async fn stored_folders(store: &ConversationStore, id: &str) -> (Option<String>, Option<String>) {
    match store.get_run_summary(id).await.expect("run summary") {
        Some(summary) => (summary.folder_path, summary.worktree_path),
        None => (None, None),
    }
}

async fn checkpoint_count(store: &ConversationStore, id: &str) -> usize {
    store
        .list_chat_checkpoints(id, 10)
        .await
        .expect("checkpoints")
        .len()
}

/// A directory link from `link` to `target`, made as a junction on Windows
/// (needs no privilege) and as a symbolic link elsewhere. Never skipped.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("cmd runs");
        assert!(
            output.status.success(),
            "the directory junction could not be made: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).expect("symbolic link");
    assert!(link.is_dir(), "the link resolves to a directory");
}
