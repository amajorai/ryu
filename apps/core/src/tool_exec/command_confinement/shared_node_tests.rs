//! Command tools on a shared node (finding CE-35). A call the node bounds
//! never runs its program outside the runner and never in a folder it
//! inherits from Core. A personal node keeps what it had.

use std::collections::{BTreeMap, HashSet};

use super::*;
use crate::plugin_manifest::schema::CommandOutput;

fn argv() -> Vec<String> {
    vec!["status".to_owned()]
}

/// A temp folder, a `store` in it that stands in for a hidden store, and a
/// program outside the store. Both paths are canonical.
fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let store = root.join("store");
    std::fs::create_dir_all(&store).unwrap();
    let bin = root.join("tool");
    std::fs::write(&bin, "").unwrap();
    (tmp, store, bin)
}

/// One call of the command runner for a program no allowlist names, with the
/// grant it needs, as the node `managed` says (managed and not registered is
/// a node that bounds its turns).
async fn run_tool(managed: bool) -> Result<serde_json::Value, String> {
    let grants = HashSet::from([format!("{GRANT_COMMAND_PREFIX}ce35-no-such-tool")]);
    crate::sidecar::control_plane::with_test_node_binding(managed, None, async {
        super::super::command_tool::run_command_tool_with_agent_and_workspace(
            "ce35-no-such-tool",
            &["status".to_string()],
            None,
            &BTreeMap::new(),
            None,
            5,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({}),
            &grants,
            "@ryu/ce35-test",
            None,
            None,
            None,
            &[],
            None,
        )
        .await
    })
    .await
}

#[test]
fn a_call_on_a_personal_node_passes_the_precheck_without_the_probe() {
    shared_node_precheck(false, || {
        panic!("no sandbox probe for a call on a personal node")
    })
    .unwrap();
}

#[test]
fn a_call_on_a_personal_node_keeps_the_manifest_folder_or_inherits() {
    let (_tmp, store, bin) = fixture();
    let inherited = command_child_dir(None, Some(&store), false, &bin, &[]).unwrap();
    assert_eq!(inherited.dir(), None);
    let declared = command_child_dir(Some("relative/dir"), None, false, &bin, &[]).unwrap();
    assert_eq!(declared.dir(), Some(Path::new("relative/dir")));
}

#[tokio::test]
async fn a_command_tool_on_a_personal_node_is_not_refused_as_shared() {
    if let Err(refused) = run_tool(false).await {
        assert!(!refused.contains("this node is shared"), "{refused}");
    }
}

// ---- the shared node rule: every test below fails on the commit before the fix ----

#[test]
fn a_bounded_call_without_path_arguments_runs_under_the_runner() {
    let (_tmp, store, bin) = fixture();
    let (program, args) = command_spawn_program(
        &bin,
        &argv(),
        false,
        std::slice::from_ref(&store),
        true,
        || Ok(()),
    )
    .unwrap();
    assert_eq!(program, std::env::current_exe().unwrap());
    assert_eq!(args[0], crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG);
    let separator = args.iter().position(|arg| arg == "--").unwrap();
    assert_eq!(args[separator + 1], bin.to_string_lossy());
    assert_eq!(&args[separator + 2..], argv().as_slice());
    // The same with no account-hidden store: Core's own data is the mask.
    std::fs::create_dir_all(crate::paths::ryu_dir()).unwrap();
    let (program, args) =
        command_spawn_program(&bin, &argv(), false, &[], true, || Ok(())).unwrap();
    assert_eq!(program, std::env::current_exe().unwrap());
    let core = std::fs::canonicalize(crate::paths::ryu_dir()).unwrap();
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == "--mask" && Path::new(&pair[1]) == core),
        "{args:?}"
    );
}

#[test]
fn a_bounded_call_is_refused_when_the_host_cannot_sandbox() {
    let (_tmp, _store, bin) = fixture();
    std::fs::create_dir_all(crate::paths::ryu_dir()).unwrap();
    for has_path_args in [false, true] {
        let refused = command_spawn_program(&bin, &argv(), has_path_args, &[], true, || {
            Err("no userns".to_owned())
        })
        .unwrap_err();
        assert!(refused.contains("this node is shared"), "{refused}");
        assert!(refused.contains("no userns"), "{refused}");
    }
}

#[test]
fn a_bounded_call_is_refused_before_the_version_check() {
    let refused = shared_node_precheck(true, || Err("no userns".to_owned())).unwrap_err();
    assert!(refused.contains("this node is shared"), "{refused}");
    assert!(refused.contains("no userns"), "{refused}");
    shared_node_precheck(true, || Ok(())).unwrap();
}

#[test]
fn the_folder_of_a_bounded_call_is_never_inherited() {
    let (_tmp, store, bin) = fixture();
    let root = store.parent().unwrap().join("project");
    std::fs::create_dir_all(&root).unwrap();
    // The turn's folder, when the caller holds one.
    let turn = command_child_dir(None, Some(&root), true, &bin, &[]).unwrap();
    assert_eq!(turn.dir(), Some(root.as_path()));
    // The manifest's own absolute folder.
    let declared = command_child_dir(root.to_str(), None, true, &bin, &[]).unwrap();
    assert_eq!(declared.dir(), Some(root.as_path()));
    // Neither: an empty folder made for the call, gone when the call ends.
    let made = command_child_dir(None, None, true, &bin, &[]).unwrap();
    let dir = made
        .dir()
        .expect("a bounded call always has a folder")
        .to_owned();
    assert!(dir.is_dir());
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    let core_cwd = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
    assert_ne!(dir, core_cwd);
    drop(made);
    assert!(!dir.exists());
}

#[test]
fn a_bounded_call_is_refused_in_a_relative_or_masked_folder() {
    let (_tmp, store, bin) = fixture();
    let relative = command_child_dir(Some("relative/dir"), None, true, &bin, &[])
        .err()
        .expect("a relative folder resolves against Core's own");
    assert!(relative.contains("not an absolute path"), "{relative}");
    let inside = store.join("inner");
    std::fs::create_dir_all(&inside).unwrap();
    let masked = command_child_dir(
        None,
        Some(&inside),
        true,
        &bin,
        std::slice::from_ref(&store),
    )
    .err()
    .expect("a folder inside a hidden store");
    assert!(masked.contains("lies inside a store"), "{masked}");
}

/// The production wiring, on a host whose own probe fails (the build PC, and
/// any host inside a test binary that is not the runner): the call is refused
/// before the allowlist, the version check or a spawn. A host that can
/// sandbox goes on to the allowlist, which is not this test's subject.
#[tokio::test]
async fn a_command_tool_on_a_shared_node_is_refused_when_the_host_cannot_sandbox() {
    let Err(reason) = crate::agent_sandbox::untrusted_support() else {
        return;
    };
    let refused = match run_tool(true).await {
        Ok(value) => panic!("the tool went on: {value}"),
        Err(refused) => refused,
    };
    assert!(refused.contains("this node is shared"), "{refused}");
    assert!(refused.contains(&reason), "{refused}");
}
