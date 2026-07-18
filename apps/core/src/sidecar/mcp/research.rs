//! Core wiring for the extracted `ryu_research` MCP tool provider.
//!
//! The 8 `research__*` tool schemas + the HTTP dispatch that drives the
//! autoresearch sidecar (:8087) now live in the `ryu-research` crate
//! (`apps-store/research/backend`), which has ZERO dependency on `apps/core`. This
//! module is the thin registry shim: it maps the crate's registry-agnostic
//! [`ryu_research::ResearchToolSpec`]s onto Core's [`super::RegistryTool`] (applying
//! the `research__<name>` id scheme), and re-exports the crate's `dispatch` +
//! `SERVER_NAME` so the `McpRegistry` call sites (`sidecar::mcp::mod`) are unchanged.
//!
//! The install check the registry reports (`is_installed`) stays with the Core-side
//! sidecar lifecycle manager (`crate::sidecar::tools::research`), which owns the
//! `~/.ryu/research-sidecar` path resolution.

use super::RegistryTool;

pub use ryu_research::{dispatch, SERVER_NAME};

/// The Research tools exposed through the registry — the crate's schema specs
/// mapped onto Core's `RegistryTool` (id = `research__<name>`, server = `research`).
pub fn tools() -> Vec<RegistryTool> {
    ryu_research::tool_specs()
        .into_iter()
        .map(|spec| RegistryTool {
            id: format!("{SERVER_NAME}__{}", spec.name),
            server: SERVER_NAME.to_owned(),
            name: spec.name,
            description: Some(spec.description),
            input_schema: Some(spec.input_schema),
            ..Default::default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_specs_to_qualified_registry_tools() {
        let tools = tools();
        assert_eq!(tools.len(), 8);
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
        assert!(tools.iter().all(|t| t.id.starts_with("research__")));
        assert!(tools.iter().any(|t| t.name == "run"));
        assert!(tools.iter().any(|t| t.name == "init_workspace"));
    }
}
