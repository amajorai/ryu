//! The provider share of one tool's exfiltration-guard flow
//! ([`super::exfiltration_guard`]).
//!
//! A provider tool called directly reaches what its verb reaches, so it is never
//! classified as less than the verb. That covers more than the tool a manifest
//! binds: a screen-capture provider binds one tool to `computer.capture`
//! (Ghost binds `ghost.ghost_annotate`), but its other tools (`ghost.ghost_read`,
//! `ghost.ghost_screenshot`, ...) return the same on-screen data. Every unbound
//! tool in the namespace of a tool bound to a private-source verb is therefore a
//! private source too. A bound tool keeps its own verbs' flow, so a provider's
//! `computer.click` or `memory.store` tool does not become a source.

use std::collections::{BTreeMap, BTreeSet};

use super::exfiltration_guard::{capability_verb_flow, provider_tool_flows, DataFlow};
use crate::plugin_manifest::PluginManifest;

/// The namespace (server name or app slug prefix) of a canonical tool id. Server
/// names may contain dots, tool names normally do not, so split at the last dot.
fn tool_namespace(tool_id: &str) -> Option<&str> {
    tool_id
        .rsplit_once('.')
        .map(|(namespace, _)| namespace)
        .filter(|namespace| !namespace.is_empty())
}

/// The namespaces of every tool an enabled manifest binds (directly or through
/// its adapter) to a private-source capability verb.
fn private_provider_namespaces(flows: &BTreeMap<String, DataFlow>) -> BTreeSet<&str> {
    flows
        .iter()
        .filter(|(_, flow)| flow.private_source)
        .filter_map(|(tool_id, _)| tool_namespace(tool_id))
        .collect()
}

/// The provider flow of a call, from the enabled `manifests`: the union of the
/// verb flows `ids` are bound to, or, when none is bound, a private read when one
/// of them sits in a private-source provider's namespace. `ids` are the canonical
/// id the program called and its resolved gate id. `None` means no provider
/// covers the call and only its origin decides its flow.
pub(crate) fn provider_flow_for(manifests: &[PluginManifest], ids: &[&str]) -> Option<DataFlow> {
    let flows = provider_tool_flows(manifests);
    let bound = ids
        .iter()
        .filter_map(|id| flows.get(*id).copied())
        .reduce(|left, right| DataFlow {
            private_source: left.private_source || right.private_source,
            egress: left.egress || right.egress,
        });
    if bound.is_some() {
        return bound;
    }
    let namespaces = private_provider_namespaces(&flows);
    ids.iter()
        // A capability verb id is classified by its own row, never widened.
        .filter(|id| capability_verb_flow(id).is_none())
        .any(|id| tool_namespace(id).is_some_and(|namespace| namespaces.contains(namespace)))
        .then_some(DataFlow {
            private_source: true,
            egress: false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifests(raw: &[&str]) -> Vec<PluginManifest> {
        raw.iter()
            .map(|raw| serde_json::from_str(raw).expect("manifest parses"))
            .collect()
    }

    fn ghost() -> Vec<PluginManifest> {
        manifests(&[include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/ghost/manifest.json"
        )])
    }

    #[test]
    fn unbound_screen_reading_tools_of_a_capture_provider_are_private() {
        let manifests = ghost();
        for tool in [
            "ghost.ghost_read",
            "ghost.ghost_screenshot",
            "ghost.ghost_snapshot",
            "ghost.ghost_find",
            "ghost.ghost_context",
            "ghost.ghost_parse_screen",
        ] {
            assert_eq!(
                provider_flow_for(&manifests, &[tool, tool]),
                Some(DataFlow {
                    private_source: true,
                    egress: false
                }),
                "{tool} reads the screen like `computer.capture`"
            );
        }
        // The bound capture tool keeps its verb's flow.
        assert!(provider_flow_for(&manifests, &["ghost.ghost_annotate"])
            .is_some_and(|flow| flow.private_source));
    }

    #[test]
    fn bound_input_tools_keep_their_own_verbs_flow() {
        let manifests = ghost();
        let click = provider_flow_for(&manifests, &["ghost.ghost_click"]).unwrap();
        assert!(!click.private_source, "a click returns no screen data");
        assert!(click.egress, "desktop input can carry data out");
        let scroll = provider_flow_for(&manifests, &["ghost.ghost_scroll"]).unwrap();
        assert_eq!(scroll, DataFlow::default());
    }

    #[test]
    fn other_namespaces_and_verbs_are_not_widened() {
        let manifests = ghost();
        assert_eq!(provider_flow_for(&manifests, &["web.extract"]), None);
        assert_eq!(provider_flow_for(&manifests, &["computer.click"]), None);
        assert_eq!(provider_flow_for(&manifests, &["ghostly.read"]), None);
        assert_eq!(provider_flow_for(&manifests, &["acme.ghost_read"]), None);
        // No enabled provider, no provider flow.
        assert_eq!(provider_flow_for(&[], &["ghost.ghost_read"]), None);
    }

    #[test]
    fn a_memory_provider_namespace_widens_only_unbound_tools() {
        let manifests = manifests(&[include_str!(
            "../plugin_manifest/fixtures/memory.manifest.json"
        )]);
        // `memorystore.list` is bound by no verb but reads the memory store.
        assert!(provider_flow_for(&manifests, &["memorystore.list"])
            .is_some_and(|flow| flow.private_source));
        // `memorystore.save` is bound to `memory.store`, which is neutral.
        assert_eq!(
            provider_flow_for(&manifests, &["memorystore.save"]),
            Some(DataFlow::default())
        );
    }
}
