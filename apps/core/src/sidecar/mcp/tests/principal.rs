//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

#[test]
fn profile_scope_allows_only_selected_source_planes() {
    assert!(profile_scope_allows_registry_tool(
        "search_conversations.search",
        true,
        true,
    ));
    assert!(profile_scope_allows_registry_tool(
        "composio.GITHUB_SEARCH_ISSUES",
        true,
        true,
    ));
    assert!(!profile_scope_allows_registry_tool(
        "composio.GITHUB_SEARCH_ISSUES",
        false,
        true,
    ));
    assert!(!profile_scope_allows_registry_tool(
        "composio_connect.search",
        true,
        true
    ));
    assert!(!profile_scope_allows_registry_tool(
        "tools.exec",
        true,
        true
    ));
    assert!(profile_scope_allows_registry_tool(
        "spaces.search",
        false,
        false
    ));
}
