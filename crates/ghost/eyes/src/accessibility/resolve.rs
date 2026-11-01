// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Strict, pure element resolution against a walked tree.
//!
//! Path first, then identity. Values are never used to locate an element (except
//! the name==value rule for mutable-value roles), more than one candidate is an
//! error, and a node whose identity drifted is never accepted.

use serde_json::{json, Value};

use super::{roles, verify, AXTreeNode, ElementIdentity, MatchBy};
use crate::contract::GhostError;

/// Maximum number of candidates listed in an AMBIGUOUS_TARGET error.
const MAX_CANDIDATES: usize = 10;

/// The node at `path` (child indices from `root`), if every index exists.
pub fn node_at_path<'a>(root: &'a AXTreeNode, path: &[u32]) -> Option<&'a AXTreeNode> {
    let mut node = root;
    for &idx in path {
        node = node.children.get(usize::try_from(idx).ok()?)?;
    }
    Some(node)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityMatch {
    Match,
    NoMatch,
}

fn both_differ(a: Option<&str>, b: Option<&str>) -> bool {
    matches!((a, b), (Some(x), Some(y)) if x != y)
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|v| !v.is_empty())
}

/// An unnamed expectation accepts a titled node only for a mutable-value role whose
/// title mirrors its (non-secure) value: the name==value rule.
fn unnamed_accepts(node: &AXTreeNode, role_key: &str) -> bool {
    let Some(title) = non_empty(node.title.as_deref()) else {
        return true;
    };
    if !roles::is_mutable_value_role(role_key) || node.secure {
        return false;
    }
    node.value
        .as_deref()
        .is_some_and(|v| v == title || verify::value_matches(role_key, title, v))
}

/// Identity rule: equal stable role; equal native ids and identifiers when both
/// sides have them; equal name when one is expected; an unnamed expectation only
/// matches an untitled node (or the name==value rule for mutable-value roles).
pub fn identity_matches(node: &AXTreeNode, id: &ElementIdentity) -> IdentityMatch {
    let role = node.stable_role();
    let ok = role == id.role_key
        && !both_differ(
            non_empty(node.native_id.as_deref()),
            id.native_id.as_deref(),
        )
        && !both_differ(
            non_empty(node.identifier.as_deref()),
            id.identifier.as_deref(),
        )
        && match id.name.as_deref() {
            Some(name) => node.title.as_deref() == Some(name),
            None => unnamed_accepts(node, &role),
        };
    if ok {
        IdentityMatch::Match
    } else {
        IdentityMatch::NoMatch
    }
}

/// `identity_matches == Match`; an identity without a native id or identifier
/// additionally needs equal `Some` bounds on both sides.
///
/// Role and name alone do not make an element unique (one "Delete" button per
/// list row): after a row is removed, a sibling with the same role and name can
/// sit at the stored path. Such a path hit falls through to the role+name step,
/// which narrows by bounds or reports AMBIGUOUS_TARGET.
pub fn accept_path_hit(node: &AXTreeNode, id: &ElementIdentity) -> bool {
    if identity_matches(node, id) != IdentityMatch::Match {
        return false;
    }
    if id.native_id.is_some() || id.identifier.is_some() {
        return true;
    }
    same_bounds(node, id)
}

#[derive(Debug)]
pub struct Resolution<'a> {
    pub node: &'a AXTreeNode,
    pub path: Vec<u32>,
    pub matched_by: MatchBy,
}

type Candidate<'a> = (Vec<u32>, &'a AXTreeNode);

fn collect_matching<'a>(
    node: &'a AXTreeNode,
    id: &ElementIdentity,
    path: &mut Vec<u32>,
    out: &mut Vec<Candidate<'a>>,
) {
    if identity_matches(node, id) == IdentityMatch::Match {
        out.push((path.clone(), node));
    }
    for (i, child) in node.children.iter().enumerate() {
        path.push(u32::try_from(i).unwrap_or(u32::MAX));
        collect_matching(child, id, path, out);
        path.pop();
    }
}

fn any_truncated(node: &AXTreeNode) -> bool {
    node.subtree_truncated || node.children.iter().any(any_truncated)
}

fn same_bounds(node: &AXTreeNode, id: &ElementIdentity) -> bool {
    matches!((&node.bounds, &id.bounds), (Some(a), Some(b)) if a == b)
}

fn candidates_json(cands: &[Candidate<'_>]) -> Value {
    Value::Array(
        cands
            .iter()
            .take(MAX_CANDIDATES)
            .map(|(path, node)| {
                json!({
                    "role": node.stable_role(),
                    "name": node.title,
                    "path": path,
                    "bounds": node.bounds,
                })
            })
            .collect(),
    )
}

fn ambiguous(cands: &[Candidate<'_>]) -> GhostError {
    let mut err = GhostError::ambiguous(
        format!("{} elements match the target", cands.len()),
        candidates_json(cands),
    )
    .with_suggestion("take a new snapshot and use a more specific ref or query");
    if let Some(Value::Object(details)) = err.details.as_mut() {
        details.insert("candidate_count".into(), json!(cands.len()));
    }
    err
}

/// Narrows plural candidates by equal `Some` bounds.
fn pick<'a>(
    cands: Vec<Candidate<'a>>,
    id: &ElementIdentity,
    single: MatchBy,
    narrowed: MatchBy,
) -> Option<Result<Resolution<'a>, GhostError>> {
    match cands.len() {
        0 => None,
        1 => {
            let (path, node) = cands.into_iter().next()?;
            Some(Ok(Resolution {
                node,
                path,
                matched_by: single,
            }))
        }
        _ => {
            let mut by_bounds = cands.iter().filter(|(_, n)| same_bounds(n, id));
            match (by_bounds.next(), by_bounds.next()) {
                (Some((path, node)), None) => Some(Ok(Resolution {
                    node,
                    path: path.clone(),
                    matched_by: narrowed,
                })),
                _ => Some(Err(ambiguous(&cands))),
            }
        }
    }
}

/// Resolves `id` in `root`, trying `path_hint` first. See the spec's algorithm:
/// path, native id, identifier, role+name, anonymous bounds, then absence.
pub fn resolve_in_tree<'a>(
    root: &'a AXTreeNode,
    id: &ElementIdentity,
    path_hint: &[u32],
) -> Result<Resolution<'a>, GhostError> {
    if let Some(node) = node_at_path(root, path_hint) {
        if accept_path_hit(node, id) {
            return Ok(Resolution {
                node,
                path: path_hint.to_vec(),
                matched_by: MatchBy::Path,
            });
        }
    }
    let mut matching = Vec::new();
    collect_matching(root, id, &mut Vec::new(), &mut matching);

    if let Some(native) = id.native_id.as_deref() {
        let cands: Vec<_> = matching
            .iter()
            .filter(|(_, n)| n.native_id.as_deref() == Some(native))
            .cloned()
            .collect();
        if let Some(r) = pick(cands, id, MatchBy::NativeId, MatchBy::NativeId) {
            return r;
        }
    }
    if let Some(ident) = id.identifier.as_deref() {
        let cands: Vec<_> = matching
            .iter()
            .filter(|(_, n)| n.identifier.as_deref() == Some(ident))
            .cloned()
            .collect();
        if let Some(r) = pick(cands, id, MatchBy::Identifier, MatchBy::Identifier) {
            return r;
        }
    }
    if id.name.as_deref().is_some_and(|n| !n.is_empty()) {
        if let Some(r) = pick(matching.clone(), id, MatchBy::RoleName, MatchBy::Bounds) {
            return r;
        }
    }
    if id.is_anonymous() {
        let mut hits = matching.iter().filter(|(_, n)| same_bounds(n, id));
        return match (hits.next(), hits.next()) {
            (Some((path, node)), None) => Ok(Resolution {
                node,
                path: path.clone(),
                matched_by: MatchBy::Bounds,
            }),
            _ => Err(GhostError::stale_ref(
                "the unnamed element is no longer where the snapshot saw it",
            )
            .with_details(json!({ "reason": "anonymous_element_moved" }))
            .with_suggestion("take a new snapshot")),
        };
    }
    if any_truncated(root) {
        Err(
            GhostError::not_found("the element was not found in the walked part of the tree")
                .with_details(json!({ "reason": "tree_incomplete" }))
                .with_suggestion("the tree was truncated; narrow the target or retry"),
        )
    } else {
        Err(GhostError::stale_ref("the element is no longer present")
            .with_details(json!({ "reason": "resolution_complete_absence" }))
            .with_suggestion("take a new snapshot"))
    }
}
