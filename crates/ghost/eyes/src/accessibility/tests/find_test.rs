use super::super::find::{find_all, find_in_tree, FindOptions};
use super::super::{AXTreeNode, Bounds};
use super::node;

const MAC: FindOptions = FindOptions {
    match_identifier: false,
    match_value: true,
};
const ALL: FindOptions = FindOptions {
    match_identifier: true,
    match_value: true,
};

fn leaf(role: &str, title: Option<&str>, value: Option<&str>) -> AXTreeNode {
    AXTreeNode {
        value: value.map(str::to_string),
        ..node(role, title)
    }
}

#[test]
fn matches_root_by_role() {
    let tree = leaf("AXButton", None, None);
    let found = find_in_tree(&tree, "axbutton", MAC).expect("role match");
    assert_eq!(found.role, "AXButton");
}

#[test]
fn matches_nested_child_by_title_case_insensitively() {
    let mut root = leaf("AXWindow", Some("Main"), None);
    root.children
        .push(leaf("AXStaticText", Some("Save Changes"), None));
    let found = find_in_tree(&root, "Save changes", MAC).expect("nested title match");
    assert_eq!(found.role, "AXStaticText");
    assert_eq!(found.title.as_deref(), Some("Save Changes"));
}

#[test]
fn matches_by_value() {
    let root = leaf("AXTextField", None, Some("hello@example.com"));
    let found = find_in_tree(&root, "example.com", MAC).expect("value match");
    assert_eq!(found.role, "AXTextField");
}

#[test]
fn does_not_match_identifier_on_macos() {
    // macOS search covers role/title/value only, NOT identifier (unlike the
    // Windows and Linux backends). Pin that difference.
    let mut node = leaf("AXGroup", None, None);
    node.identifier = Some("submit-btn".to_string());
    node.bounds = Some(Bounds {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
    });
    assert!(find_in_tree(&node, "submit-btn", MAC).is_none());
    assert!(find_in_tree(&node, "submit-btn", ALL).is_some());
}

#[test]
fn match_value_flag_is_honoured() {
    let root = leaf("AXTextField", None, Some("needle"));
    let no_value = FindOptions {
        match_identifier: true,
        match_value: false,
    };
    assert!(find_in_tree(&root, "needle", no_value).is_none());
}

#[test]
fn returns_none_when_absent() {
    let mut root = leaf("AXWindow", Some("Editor"), None);
    root.children.push(leaf("AXButton", Some("OK"), None));
    root.children.push(leaf("AXButton", Some("Cancel"), None));
    assert!(find_in_tree(&root, "nonexistent-zzz", MAC).is_none());
}

#[test]
fn returns_first_match_depth_first() {
    let mut root = leaf("AXWindow", Some("target-word"), None);
    root.children
        .push(leaf("AXButton", Some("target-word"), None));
    let found = find_in_tree(&root, "target-word", MAC).expect("match");
    assert_eq!(found.role, "AXWindow");
}

#[test]
fn empty_query_matches_nothing() {
    let root = leaf("AXWindow", Some("Editor"), None);
    assert!(find_in_tree(&root, "", ALL).is_none());
    assert!(find_in_tree(&root, "   ", ALL).is_none());
    assert!(find_all(&root, "", ALL, 10).is_empty());
}

#[test]
fn secure_value_never_matches() {
    let mut pw = leaf("AXSecureTextField", None, Some("hunter2"));
    pw.secure = true;
    let mut root = leaf("AXWindow", Some("Login"), None);
    root.children.push(pw);
    assert!(find_in_tree(&root, "hunter2", ALL).is_none());
    assert!(find_all(&root, "hunter2", ALL, 10).is_empty());
}

#[test]
fn find_all_returns_paths_in_walker_order() {
    let mut group = leaf("AXGroup", None, None);
    group.children.push(leaf("AXButton", Some("Go"), None));
    group.children.push(leaf("AXButton", Some("Go back"), None));
    let mut root = leaf("AXWindow", Some("W"), None);
    root.children.push(leaf("AXButton", Some("Go first"), None));
    root.children.push(group);
    let hits = find_all(&root, "go", ALL, 10);
    let paths: Vec<Vec<u32>> = hits.iter().map(|(p, _)| p.clone()).collect();
    assert_eq!(paths, vec![vec![0], vec![1, 0], vec![1, 1]]);
    assert_eq!(hits[1].1.title.as_deref(), Some("Go"));
    assert_eq!(find_all(&root, "go", ALL, 2).len(), 2);
}
