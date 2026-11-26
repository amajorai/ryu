//! The rule itself: which node is bounded, how the list is read, how one folder
//! is judged and what the boundary does to the folder fields of a turn.

use super::*;

#[tokio::test]
async fn only_a_shared_node_bounds_turn_folders() {
    let bounded = |managed: bool, node: Option<RegisteredNode>| {
        with_test_node_binding(managed, node, async { node_bounds_turn_folders() })
    };
    assert!(bounded(true, Some(node(NodeScope::Org))).await);
    assert!(bounded(true, Some(node(NodeScope::Team))).await);
    assert!(bounded(false, Some(node(NodeScope::Org))).await);
    assert!(
        bounded(true, None).await,
        "a managed node that is not registered yet is bounded"
    );
    assert!(!bounded(true, Some(node(NodeScope::Personal))).await);
    assert!(!bounded(false, Some(node(NodeScope::Personal))).await);
    assert!(!bounded(false, None).await, "the unbound personal node");
}

/// A personal node is untouched: no field changes, whatever it holds, and no
/// stored folder is refused.
#[tokio::test]
async fn a_personal_node_keeps_every_folder_field_as_sent() {
    let folder = tempfile::tempdir().expect("folder");
    let cwd = folder.path().to_string_lossy().into_owned();
    for (managed, registered) in [(false, None), (true, Some(node(NodeScope::Personal)))] {
        let mut request = turn(
            "conv-personal",
            json!({
                "cwd": cwd,
                "workspace_folders": [cwd, "/no/such/folder/anywhere"],
                "worktree_path": "/no/such/worktree",
                "worktree_isolation": true,
            }),
        );
        let before = serde_json::to_value(&request).expect("request");
        let outcome = with_test_node_binding(managed, registered, async {
            (
                bound_request(&mut request),
                bound_request_before_claim(&mut request).await,
                stored_folder_allowed(Path::new("/no/such/folder/anywhere")),
                stored_turn_refusal(Some("/no/such/folder/anywhere"), Some("/")),
            )
        })
        .await;
        assert_eq!(outcome, (Ok(()), Ok(()), true, None));
        assert_eq!(serde_json::to_value(&request).expect("request"), before);
    }
}

#[test]
fn the_list_drops_every_entry_it_cannot_fully_trust() {
    let folder = tempfile::tempdir().expect("folder");
    let file = folder.path().join("file.txt");
    std::fs::write(&file, b"x").expect("file");
    let good = list_value(&[folder.path()]);
    assert_eq!(parse_member_roots(&good).len(), 1, "{good}");

    let home = dirs::home_dir().expect("home");
    let root = home.ancestors().last().expect("root").to_path_buf();
    let mut refused = vec![
        ("a filesystem root", json!([{ "path": root }])),
        ("the home directory", json!([{ "path": home }])),
        ("a relative path", json!([{ "path": "projects" }])),
        ("a file", json!([{ "path": file }])),
        (
            "a folder that does not exist",
            json!([{ "path": folder.path().join("missing") }]),
        ),
        (
            "an entry with an unknown field",
            json!([{ "path": folder.path(), "writable": true }]),
        ),
        ("a bare string entry", json!([folder.path()])),
        ("a value that is no list", json!({ "path": folder.path() })),
        ("an empty list", json!([])),
    ];
    if let Some(parent) = home.parent().filter(|parent| parent.parent().is_some()) {
        refused.push(("a directory above the home", json!([{ "path": parent }])));
    }
    let ryu = crate::paths::ryu_dir();
    if ryu.is_dir() {
        refused.push(("the directory of Ryu's own data", json!([{ "path": ryu }])));
    }
    for (what, value) in refused {
        assert_eq!(
            parse_member_roots(&value.to_string()),
            Vec::<PathBuf>::new(),
            "{what} must allow nothing: {value}"
        );
    }
    assert_eq!(parse_member_roots("not json"), Vec::<PathBuf>::new());
    assert_eq!(parse_member_roots(""), Vec::<PathBuf>::new());

    // A bad entry is dropped; it never widens or empties the rest of the list.
    let mixed = json!([{ "path": home }, { "path": folder.path() }]).to_string();
    assert_eq!(parse_member_roots(&mixed), parse_member_roots(&good));
}

#[test]
fn a_folder_is_judged_by_where_it_resolves() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let inner = allowed.path().join("project");
    std::fs::create_dir_all(&inner).expect("inner");
    let roots = roots_of(&[allowed.path()]);
    let judged = |raw: &Path| judge(raw.to_str(), &roots);

    assert_eq!(judge(None, &roots), Folder::Absent);
    assert_eq!(judge(Some("   "), &roots), Folder::Absent);
    assert_eq!(judged(&allowed.path().join("missing")), Folder::Absent);
    assert_eq!(
        judged(allowed.path()),
        Folder::Inside(PathBuf::from(real(allowed.path())))
    );
    assert_eq!(judged(&inner), Folder::Inside(PathBuf::from(real(&inner))));
    assert_eq!(judged(outside.path()), Folder::Outside);
    // A path that walks out of the member folder and back is judged where it lands.
    assert_eq!(
        judged(&inner.join("..").join("..").join("..")),
        Folder::Outside
    );
    // Nothing is inside an empty list.
    assert_eq!(judge(allowed.path().to_str(), &[]), Folder::Outside);
}

/// A link inside a member folder that points outside is outside. Runs on Windows
/// through a directory junction and elsewhere through a symbolic link.
#[test]
fn a_link_that_leaves_the_member_folder_is_outside() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("secret.txt"), b"secret").expect("file");
    let link = allowed.path().join("link");
    link_dir(&link, outside.path());
    let roots = roots_of(&[allowed.path()]);
    assert_eq!(judge(link.to_str(), &roots), Folder::Outside);
    assert_eq!(
        judge(link.join("secret.txt").to_str(), &roots),
        Folder::Outside
    );
}

#[test]
fn the_boundary_refuses_outside_clears_what_is_absent_and_resolves_the_rest() {
    let allowed = tempfile::tempdir().expect("allowed");
    let outside = tempfile::tempdir().expect("outside");
    let extra_dir = allowed.path().join("extra");
    std::fs::create_dir_all(&extra_dir).expect("extra");
    let extra = extra_dir.as_path();
    let roots = roots_of(&[allowed.path()]);
    fn as_text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    let run = |cwd: Option<&Path>, extras: &[&Path], worktree: Option<&Path>| {
        let mut cwd = cwd.map(as_text);
        let mut folders: Vec<String> = extras.iter().map(|path| as_text(path)).collect();
        let mut worktree = worktree.map(as_text);
        let result = bound_turn_in(
            TurnFolders {
                cwd: &mut cwd,
                workspace_folders: &mut folders,
                worktree_path: &mut worktree,
                worktree_isolation: false,
            },
            &roots,
        );
        (result, cwd, folders, worktree)
    };
    let missing_dir = allowed.path().join("missing");
    let missing = missing_dir.as_path();

    // Inside: every field becomes its resolved path.
    assert_eq!(
        run(Some(allowed.path()), &[extra], Some(extra)),
        (
            Ok(()),
            Some(real(allowed.path())),
            vec![real(extra)],
            Some(real(extra))
        )
    );
    // Not resolving: cleared, the turn goes on with no folder.
    assert_eq!(
        run(Some(missing), &[missing, extra], Some(missing)),
        (Ok(()), None, vec![real(extra)], None)
    );
    // Outside, in any one field: refused.
    for refused in [
        run(Some(outside.path()), &[], None),
        run(Some(allowed.path()), &[outside.path()], None),
        run(Some(allowed.path()), &[], Some(outside.path())),
        run(None, &[], Some(outside.path())),
    ] {
        assert_eq!(refused.0, Err(FOLDER_UNAVAILABLE_MESSAGE));
    }
}
