//! The working folder of an engine turn, on a personal node and on a shared one.
//! A shared node never lends Core's own directory to a turn, and the folders an
//! engine session is rooted in are the resolved ones the boundary checked.

use std::future::Future;
use std::path::Path;

use serde_json::json;

use super::*;
use crate::server::chat_checkpoints::turn_folders::{
    parse_member_roots, with_test_member_roots, FOLDER_REQUIRED_MESSAGE,
};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

fn node(scope: NodeScope) -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope,
        team_id: None,
        owner_user_id: (scope == NodeScope::Personal).then(|| "owner-1".to_owned()),
    }
}

/// Run `fut` on a shared node (registered, scope Org) whose member folders are `dirs`.
async fn on_shared_node<F: Future>(dirs: &[&Path], fut: F) -> F::Output {
    let value = serde_json::Value::Array(
        dirs.iter()
            .map(|dir| json!({ "path": dir.to_string_lossy() }))
            .collect(),
    )
    .to_string();
    let roots = parse_member_roots(&value);
    assert_eq!(roots.len(), dirs.len(), "usable member folders: {value}");
    with_test_node_binding(
        true,
        Some(node(NodeScope::Org)),
        with_test_member_roots(roots, fut),
    )
    .await
}

fn engine() -> AgentRoute {
    AgentRoute::Acp {
        spawn_cmd: "engine acp".to_owned(),
    }
}

fn request(body: serde_json::Value) -> ChatStreamRequest {
    serde_json::from_value(body).expect("request")
}

fn no_worktrees() -> crate::server::WorktreeDiffStore {
    std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The resolved form the boundary hands on (no `\\?\` prefix on Windows).
fn resolved(path: &Path) -> String {
    let text = std::fs::canonicalize(path)
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_owned(),
        None => text,
    }
}

async fn body_text(response: Response) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body");
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn an_engine_turn_with_no_folder_is_refused_on_a_shared_node() {
    let allowed = tempfile::tempdir().expect("allowed");
    let store = ConversationStore::open_in_memory().expect("store");
    let missing = allowed.path().join("not-here");
    on_shared_node(&[allowed.path()], async {
        // No folder at all, and a folder that does not resolve (cleared at admission).
        for body in [json!({}), json!({ "cwd": missing })] {
            let mut req = request(body);
            assert!(admit_chat_turn(&mut req, &store).await.is_ok());
            assert_eq!(req.cwd, None, "no folder goes on from admission");
            let outcome =
                allocate_turn_worktree(&req, &engine(), &no_worktrees(), &Vec::new()).await;
            let Err(response) = outcome else {
                panic!("an engine turn must never get Core's own directory");
            };
            assert!(body_text(response).await.contains(FOLDER_REQUIRED_MESSAGE));
        }
    })
    .await;
}

#[tokio::test]
async fn on_a_personal_node_an_engine_turn_with_no_folder_runs_in_cores_directory() {
    for (managed, registered) in [(false, None), (true, Some(node(NodeScope::Personal)))] {
        let req = request(json!({}));
        let outcome = with_test_node_binding(managed, registered, async {
            allocate_turn_worktree(&req, &engine(), &no_worktrees(), &Vec::new()).await
        })
        .await;
        let Ok((reused, cwd, guard)) = outcome else {
            panic!("a personal node keeps the fallback");
        };
        assert!(!reused);
        assert!(guard.is_none());
        assert_eq!(cwd, std::env::current_dir().expect("current directory"));
    }
}

/// The extra folders of a project reach the engine session as sent on a
/// personal node. On a shared node they arrive resolved, so the session (and
/// the key of the session pool, which is built from them) holds what was checked.
#[tokio::test]
async fn extra_folders_reach_the_engine_as_sent_or_resolved() {
    let allowed = tempfile::tempdir().expect("allowed");
    let first = allowed.path().join("first");
    let second = allowed.path().join("second");
    std::fs::create_dir_all(&first).expect("first");
    std::fs::create_dir_all(&second).expect("second");
    // The second folder, named in a form that is not its resolved path.
    let roundabout = first.join("..").join("second");
    let body = json!({ "cwd": first, "workspace_folders": [first, roundabout] });
    let store = ConversationStore::open_in_memory().expect("store");
    let scope_of = |req: &ChatStreamRequest| {
        let cwd = PathBuf::from(req.cwd.clone().expect("cwd"));
        let req = req.clone();
        let store = store.clone();
        async move {
            acp_session_scope(
                &req,
                &cwd,
                "engine acp",
                "acp:engine",
                &store,
                &None,
                &None,
                &Vec::new(),
                &Vec::new(),
            )
            .await
            .additional_directories
        }
    };

    let mut personal = request(body.clone());
    let sent = (personal.cwd.clone(), personal.workspace_folders.clone());
    let extra = with_test_node_binding(false, None, async {
        assert!(admit_chat_turn(&mut personal, &store).await.is_ok());
        scope_of(&personal).await
    })
    .await;
    assert_eq!((personal.cwd, personal.workspace_folders), sent);
    assert_eq!(extra, vec![roundabout.clone()]);

    let mut shared = request(body);
    let extra = on_shared_node(&[allowed.path()], async {
        assert!(admit_chat_turn(&mut shared, &store).await.is_ok());
        scope_of(&shared).await
    })
    .await;
    assert_eq!(shared.cwd, Some(resolved(&first)));
    assert_eq!(
        shared.workspace_folders,
        vec![resolved(&first), resolved(&second)]
    );
    assert_eq!(extra, vec![PathBuf::from(resolved(&second))]);
}

/// Worktree isolation on a personal node is unchanged: the turn runs in a
/// managed worktree of the repository. Needs `git` on PATH.
#[tokio::test]
async fn on_a_personal_node_isolation_still_allocates_a_managed_worktree() {
    let repo = tempfile::tempdir().expect("repo");
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(repo.path())
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
            ])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    let req = request(json!({ "cwd": repo.path(), "worktree_isolation": true }));
    let outcome = with_test_node_binding(false, None, async {
        allocate_turn_worktree(&req, &engine(), &no_worktrees(), &Vec::new()).await
    })
    .await;
    let Ok((reused, cwd, guard)) = outcome else {
        panic!("the managed worktree could not be allocated");
    };
    let guard = guard.expect("a managed worktree");
    assert!(!reused);
    assert_eq!(cwd, guard.path);
    assert!(cwd.is_dir());
    assert_ne!(resolved(&cwd), resolved(repo.path()));
}
