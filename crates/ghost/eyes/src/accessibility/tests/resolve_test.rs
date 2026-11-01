use super::super::resolve::{accept_path_hit, identity_matches, resolve_in_tree, IdentityMatch};
use super::super::{AXTreeNode, ElementIdentity, MatchBy};
use super::{bounds, node};
use crate::contract::{Delivery, ErrorCode};

fn button(title: &str) -> AXTreeNode {
    node("AXButton", Some(title))
}

fn with_id(mut n: AXTreeNode, id: &str) -> AXTreeNode {
    n.identifier = Some(id.to_string());
    n
}

fn window(children: Vec<AXTreeNode>) -> AXTreeNode {
    AXTreeNode {
        children,
        ..node("AXWindow", Some("Main"))
    }
}

fn reason(err: &crate::contract::GhostError) -> &str {
    err.details.as_ref().unwrap()["reason"].as_str().unwrap()
}

#[test]
fn path_hit() {
    let mut save = button("Save");
    save.bounds = Some(bounds(20, 0));
    let tree = window(vec![button("Cancel"), save.clone()]);
    let id = ElementIdentity::from_node(&save);
    let r = resolve_in_tree(&tree, &id, &[1]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::Path);
    assert_eq!(r.path, vec![1]);
}

#[test]
fn path_hit_with_an_id_needs_no_bounds() {
    let save = with_id(button("Save"), "save-btn");
    let id = ElementIdentity::from_node(&save);
    let tree = window(vec![button("Cancel"), save]);
    assert_eq!(
        resolve_in_tree(&tree, &id, &[1]).unwrap().matched_by,
        MatchBy::Path
    );
}

#[test]
fn named_path_hit_with_moved_bounds_is_not_taken_for_a_sibling() {
    // Row 3's "Delete" at [1]; row 1 removed, so row 4's "Delete" now sits there.
    let mut row3 = button("Delete");
    row3.bounds = Some(bounds(0, 60));
    let id = ElementIdentity::from_node(&row3);
    let mut row2 = button("Delete");
    row2.bounds = Some(bounds(0, 20));
    let mut row4 = button("Delete");
    row4.bounds = Some(bounds(0, 40));
    let tree = window(vec![row2.clone(), row4.clone()]);
    assert!(!accept_path_hit(&tree.children[1], &id));
    let err = resolve_in_tree(&tree, &id, &[1]).expect_err("ambiguous");
    assert_eq!(err.code, ErrorCode::AmbiguousTarget);
    // Row 3 still present (it moved up): narrowed by its bounds, not the path.
    let tree = window(vec![row2, row3, row4]);
    let r = resolve_in_tree(&tree, &id, &[2]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::Bounds);
    assert_eq!(r.path, vec![1]);
}

#[test]
fn unique_named_element_without_bounds_resolves_by_role_and_name() {
    let id = ElementIdentity::from_node(&button("Save"));
    let tree = window(vec![button("Cancel"), button("Save")]);
    let r = resolve_in_tree(&tree, &id, &[1]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::RoleName);
    assert_eq!(r.path, vec![1]);
}

#[test]
fn identifier_wins_over_moved_path() {
    let saved = with_id(button("Save"), "save-btn");
    let id = ElementIdentity::from_node(&saved);
    let tree = window(vec![button("Cancel"), button("Help"), saved]);
    let r = resolve_in_tree(&tree, &id, &[0]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::Identifier);
    assert_eq!(r.path, vec![2]);
}

#[test]
fn identifier_with_drifted_name_is_not_accepted() {
    let id = ElementIdentity::from_node(&with_id(button("Save"), "save-btn"));
    let tree = window(vec![with_id(button("Store"), "save-btn")]);
    assert_eq!(
        identity_matches(&tree.children[0], &id),
        IdentityMatch::NoMatch
    );
    let err = resolve_in_tree(&tree, &id, &[0]).expect_err("refused");
    assert_eq!(err.code, ErrorCode::StaleRef);
    assert_eq!(err.delivery, Delivery::NotDelivered);
}

#[test]
fn same_role_and_name_is_ambiguous() {
    let id = ElementIdentity::from_node(&button("OK"));
    let tree = window(vec![button("Cancel"), button("OK"), button("OK")]);
    let err = resolve_in_tree(&tree, &id, &[0]).expect_err("ambiguous");
    assert_eq!(err.code, ErrorCode::AmbiguousTarget);
    let details = err.details.unwrap();
    assert_eq!(details["candidate_count"], 2);
    assert_eq!(details["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(details["candidates"][0]["path"], serde_json::json!([1]));
    assert_eq!(details["candidates"][0]["role"], "button");
}

#[test]
fn bounds_break_a_tie() {
    let mut a = button("OK");
    a.bounds = Some(bounds(0, 0));
    let mut b = button("OK");
    b.bounds = Some(bounds(100, 0));
    let id = ElementIdentity::from_node(&b);
    let tree = window(vec![button("Cancel"), a, b]);
    let r = resolve_in_tree(&tree, &id, &[0]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::Bounds);
    assert_eq!(r.path, vec![2]);
}

#[test]
fn anonymous_path_hit_without_bounds_is_refused() {
    let group = node("AXGroup", None);
    let id = ElementIdentity::from_node(&group);
    assert!(id.is_anonymous());
    let tree = window(vec![group]);
    assert!(!accept_path_hit(&tree.children[0], &id));
    let err = resolve_in_tree(&tree, &id, &[0]).expect_err("refused");
    assert_eq!(err.code, ErrorCode::StaleRef);
    assert_eq!(reason(&err), "anonymous_element_moved");
}

#[test]
fn unnamed_entry_never_matches_unnamed_node_with_other_bounds() {
    let mut stored = node("AXGroup", None);
    stored.bounds = Some(bounds(0, 0));
    let id = ElementIdentity::from_node(&stored);
    let mut moved = node("AXGroup", None);
    moved.bounds = Some(bounds(50, 50));
    let tree = window(vec![moved]);
    let err = resolve_in_tree(&tree, &id, &[0]).expect_err("refused");
    assert_eq!(err.code, ErrorCode::StaleRef);
    // Same bounds is accepted.
    let mut same = node("AXGroup", None);
    same.bounds = Some(bounds(0, 0));
    let tree = window(vec![same]);
    assert_eq!(
        resolve_in_tree(&tree, &id, &[0]).unwrap().matched_by,
        MatchBy::Path
    );
}

#[test]
fn unnamed_entry_does_not_match_named_button() {
    let id = ElementIdentity::from_parts("button", None, None, Some("x"), None, None);
    assert_eq!(
        identity_matches(&with_id(button("Go"), "x"), &id),
        IdentityMatch::NoMatch
    );
}

#[test]
fn checkbox_with_changed_value_still_resolves() {
    let mut before = node("AXCheckBox", Some("Subscribe"));
    before.value = Some("0".to_string());
    let id = ElementIdentity::from_node(&before);
    let mut after = node("AXCheckBox", Some("Subscribe"));
    after.value = Some("1".to_string());
    let tree = window(vec![after]);
    let r = resolve_in_tree(&tree, &id, &[0]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::RoleName);
    assert_eq!(r.path, vec![0]);
}

#[test]
fn slider_named_after_its_value_resolves_after_change() {
    let mut before = node("AXSlider", Some("50"));
    before.value = Some("50".to_string());
    before.bounds = Some(bounds(5, 5));
    let id = ElementIdentity::from_node(&before);
    assert!(id.name.is_none());
    let mut after = node("AXSlider", Some("60"));
    after.value = Some("60".to_string());
    after.bounds = Some(bounds(5, 5));
    let tree = window(vec![button("x"), after]);
    let r = resolve_in_tree(&tree, &id, &[1]).expect("resolves");
    assert_eq!(r.path, vec![1]);
    // Also found again when it moved.
    let r = resolve_in_tree(&tree, &id, &[0]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::Bounds);
}

#[test]
fn truncated_tree_without_match_is_not_found() {
    let id = ElementIdentity::from_node(&button("Missing"));
    let mut group = node("AXGroup", None);
    group.subtree_truncated = true;
    let tree = window(vec![group]);
    let err = resolve_in_tree(&tree, &id, &[0]).expect_err("missing");
    assert_eq!(err.code, ErrorCode::ElementNotFound);
    assert_eq!(reason(&err), "tree_incomplete");
}

#[test]
fn complete_tree_without_match_is_stale() {
    let id = ElementIdentity::from_node(&button("Missing"));
    let tree = window(vec![button("Other")]);
    let err = resolve_in_tree(&tree, &id, &[0]).expect_err("missing");
    assert_eq!(err.code, ErrorCode::StaleRef);
    assert_eq!(reason(&err), "resolution_complete_absence");
}

#[test]
fn native_id_must_agree() {
    let mut stored = button("Go");
    stored.native_id = Some(":1.5:/a/1".to_string());
    let id = ElementIdentity::from_node(&stored);
    let mut other = button("Go");
    other.native_id = Some(":1.5:/a/2".to_string());
    assert_eq!(identity_matches(&other, &id), IdentityMatch::NoMatch);
    let tree = window(vec![other, stored]);
    let r = resolve_in_tree(&tree, &id, &[0]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::NativeId);
    assert_eq!(r.path, vec![1]);
}

#[test]
fn bad_path_hint_is_harmless() {
    let id = ElementIdentity::from_node(&button("Save"));
    let tree = window(vec![button("Save")]);
    let r = resolve_in_tree(&tree, &id, &[7, 3]).expect("resolves");
    assert_eq!(r.matched_by, MatchBy::RoleName);
}

#[test]
fn read_error_truncation_makes_the_walk_incomplete() {
    use super::super::{TruncationCause, WalkStats};
    let mut stats = WalkStats::default();
    let mut group = node("AXGroup", None);
    stats.mark_truncated(&mut group, TruncationCause::ReadError);
    assert!(group.subtree_truncated);
    assert!(stats.read_error_hit);
    assert!(!stats.complete());
    let id = ElementIdentity::from_node(&button("Inside"));
    let err = resolve_in_tree(&window(vec![group]), &id, &[0, 0]).expect_err("missing");
    assert_eq!(reason(&err), "tree_incomplete");
}
