//! Folder trust on a shared node (finding CE-35). The trust list is the
//! owner's. For a turn the node bounds it lifts nothing; a personal node keeps
//! what it had.

use super::*;

/// A folder on the node's trust list. The list is process-global, so the lock
/// is held for the test and the list is emptied again when the guard drops.
struct TrustedFolder {
    dir: tempfile::TempDir,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl TrustedFolder {
    fn new() -> Self {
        let lock = crate::workspace_trust::TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempfile::tempdir().unwrap();
        crate::workspace_trust::set_from_pref(
            &serde_json::to_string(&[dir.path().to_string_lossy()]).unwrap(),
        );
        Self { dir, _lock: lock }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }
}

impl Drop for TrustedFolder {
    fn drop(&mut self) {
        crate::workspace_trust::set_from_pref("");
    }
}

#[test]
fn a_personal_node_trusts_a_folder_on_the_trust_list() {
    let folder = TrustedFolder::new();
    let autonomy = WorkspaceAutonomy::evaluate(folder.path(), &[], true, false);
    assert!(autonomy.trusted);
    assert_eq!(autonomy.refuse_mode("bypassPermissions"), None);
}

#[tokio::test]
async fn a_personal_node_asks_the_trust_list_for_its_instances() {
    let folder = TrustedFolder::new();
    let autonomy = crate::sidecar::control_plane::with_test_node_binding(false, None, async {
        WorkspaceAutonomy::for_this_node(folder.path(), &[], false)
    })
    .await;
    assert!(autonomy.trusted);
}

// ---- the shared node rule: every test below fails on the commit before the fix ----

#[test]
fn a_bounded_turn_is_never_trusted_and_keeps_refusing_modes_that_skip_prompts() {
    let folder = TrustedFolder::new();
    let autonomy = WorkspaceAutonomy::evaluate(folder.path(), &[], true, true);
    assert!(!autonomy.trusted, "folder trust lifted a bounded turn");
    assert!(autonomy.refuse_mode("bypassPermissions").is_some());
}

/// The production wiring: an instance on a node that bounds its turns (here a
/// managed node that is not registered yet) is never trusted.
#[tokio::test]
async fn a_shared_node_never_trusts_a_folder_for_its_instances() {
    let folder = TrustedFolder::new();
    let autonomy = crate::sidecar::control_plane::with_test_node_binding(true, None, async {
        WorkspaceAutonomy::for_this_node(folder.path(), &[], false)
    })
    .await;
    assert!(
        !autonomy.trusted,
        "folder trust lifted a shared node's turn"
    );
}
