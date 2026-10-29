//! `restore_pinned` pins its "Before rewind" snapshot for the owner, so the
//! rewind can be undone even after the store is garbage-collected. A plain
//! `restore` leaves that snapshot unpinned and collectable.

use std::path::Path;

use crate::checkpoints::{Snapshot, SnapshotOutcome, WorkspaceCheckpoints};

fn captured(outcome: SnapshotOutcome) -> Snapshot {
    match outcome {
        SnapshotOutcome::Captured(snapshot) => snapshot,
        SnapshotOutcome::Skipped(reason) => panic!("snapshot skipped: {reason:?}"),
    }
}

fn read(root: &Path, relative: &str) -> String {
    std::fs::read_to_string(root.join(relative)).expect("read")
}

/// A workspace with a pinned checkpoint of `v1` for `conv-a`, then edited to
/// `v2` plus a new file, and rewound to the checkpoint.
struct Rewound {
    _store: tempfile::TempDir,
    workspace: tempfile::TempDir,
    checkpoints: WorkspaceCheckpoints,
    pre_restore: String,
}

fn rewind(pinned: bool) -> Rewound {
    let store = tempfile::tempdir().expect("store");
    let workspace = tempfile::tempdir().expect("workspace");
    let checkpoints = WorkspaceCheckpoints::new(store.path().to_path_buf());
    let root = workspace.path();
    std::fs::write(root.join("a.txt"), "v1\n").unwrap();
    let target = captured(
        checkpoints
            .snapshot_pinned(root, "turn 1", "conv-a")
            .unwrap(),
    );
    std::fs::write(root.join("a.txt"), "v2\n").unwrap();
    std::fs::write(root.join("new.txt"), "created later\n").unwrap();

    let report = if pinned {
        checkpoints.restore_pinned(root, &target.commit, "conv-a")
    } else {
        checkpoints.restore(root, &target.commit)
    }
    .expect("rewind");
    assert_eq!(read(root, "a.txt"), "v1\n", "rewind restored the target");
    assert!(
        !root.join("new.txt").exists(),
        "rewind removed the new file"
    );
    assert_eq!(report.removed, vec!["new.txt".to_string()]);
    assert_eq!(report.restored, vec!["a.txt".to_string()]);
    assert_ne!(report.pre_restore.commit, target.commit);

    Rewound {
        _store: store,
        workspace,
        checkpoints,
        pre_restore: report.pre_restore.commit,
    }
}

/// Garbage-collect the store: releasing an owner with no snapshots runs the
/// same collection a prune does, dropping everything no owner pins.
fn collect(rewound: &Rewound) {
    rewound
        .checkpoints
        .release_owner(rewound.workspace.path(), "conv-unrelated")
        .expect("collect");
}

#[test]
fn pinned_rewind_can_be_undone_after_collection() {
    let rewound = rewind(true);
    collect(&rewound);
    let root = rewound.workspace.path();

    let undo = rewound
        .checkpoints
        .restore(root, &rewound.pre_restore)
        .expect("the pre-rewind snapshot survives collection");
    assert_eq!(read(root, "a.txt"), "v2\n");
    assert_eq!(read(root, "new.txt"), "created later\n");
    assert!(undo.skipped.is_empty(), "skipped: {:?}", undo.skipped);
}

#[test]
fn pinned_rewind_snapshot_is_released_with_its_owner() {
    let rewound = rewind(true);
    let root = rewound.workspace.path();
    rewound.checkpoints.release_owner(root, "conv-a").unwrap();
    let error = rewound
        .checkpoints
        .restore(root, &rewound.pre_restore)
        .expect_err("released owner's snapshot is gone");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(
        read(root, "a.txt"),
        "v1\n",
        "failed undo leaves files alone"
    );
}

#[test]
fn plain_rewind_leaves_the_pre_restore_snapshot_unpinned() {
    let rewound = rewind(false);
    collect(&rewound);
    let root = rewound.workspace.path();

    let error = rewound
        .checkpoints
        .restore(root, &rewound.pre_restore)
        .expect_err("unpinned pre-rewind snapshot is collected");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(
        read(root, "a.txt"),
        "v1\n",
        "failed undo leaves files alone"
    );
}
