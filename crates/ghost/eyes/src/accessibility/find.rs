//! Substring search over an accessibility tree (one copy for every backend).
//!
//! Matching is case-insensitive over role and title, plus identifier and value
//! when the options allow. A secure node's value is never compared.

use super::AXTreeNode;

#[derive(Debug, Clone, Copy)]
pub struct FindOptions {
    pub match_identifier: bool,
    pub match_value: bool,
}

impl Default for FindOptions {
    fn default() -> Self {
        Self {
            match_identifier: true,
            match_value: true,
        }
    }
}

fn contains_ci(field: Option<&str>, query: &str) -> bool {
    field.is_some_and(|s| s.to_lowercase().contains(query))
}

fn node_matches(node: &AXTreeNode, query: &str, opts: FindOptions) -> bool {
    node.role.to_lowercase().contains(query)
        || contains_ci(node.title.as_deref(), query)
        || (opts.match_value && !node.secure && contains_ci(node.value.as_deref(), query))
        || (opts.match_identifier && contains_ci(node.identifier.as_deref(), query))
}

/// Normalized query, or `None` for an empty one (which would match every node).
fn normalize(query: &str) -> Option<String> {
    if query.trim().is_empty() {
        None
    } else {
        Some(query.to_lowercase())
    }
}

/// First match in pre-order. An empty query gives `None`.
pub fn find_in_tree(node: &AXTreeNode, query: &str, opts: FindOptions) -> Option<AXTreeNode> {
    let q = normalize(query)?;
    first_match(node, &q, opts).cloned()
}

fn first_match<'a>(node: &'a AXTreeNode, q: &str, opts: FindOptions) -> Option<&'a AXTreeNode> {
    if node_matches(node, q, opts) {
        return Some(node);
    }
    node.children.iter().find_map(|c| first_match(c, q, opts))
}

/// Every match (up to `limit`) as `(path, node)`, in walker (pre-)order.
pub fn find_all<'a>(
    node: &'a AXTreeNode,
    query: &str,
    opts: FindOptions,
    limit: usize,
) -> Vec<(Vec<u32>, &'a AXTreeNode)> {
    let mut out = Vec::new();
    let Some(q) = normalize(query) else {
        return out;
    };
    let mut path = Vec::new();
    collect(node, &q, opts, limit, &mut path, &mut out);
    out
}

fn collect<'a>(
    node: &'a AXTreeNode,
    q: &str,
    opts: FindOptions,
    limit: usize,
    path: &mut Vec<u32>,
    out: &mut Vec<(Vec<u32>, &'a AXTreeNode)>,
) {
    if out.len() >= limit {
        return;
    }
    if node_matches(node, q, opts) {
        out.push((path.clone(), node));
    }
    for (i, child) in node.children.iter().enumerate() {
        if out.len() >= limit {
            return;
        }
        path.push(u32::try_from(i).unwrap_or(u32::MAX));
        collect(child, q, opts, limit, path, out);
        path.pop();
    }
}
