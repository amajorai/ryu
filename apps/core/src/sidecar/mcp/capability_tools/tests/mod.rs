//! Tests of the capability tool facade, by area. Shared fixtures live here.

use super::*;
use crate::plugin_manifest::ProvidesEntry;

fn search_provider(id: &str, is_default: bool, tool: &str) -> PluginManifest {
    let mut binding = CapabilityToolBinding {
        tool: tool.to_owned(),
        ..Default::default()
    };
    binding
        .args
        .insert("limit".to_owned(), "num_results".to_owned());
    binding.response = Some(CapabilityResponseMap {
        results: Some("results".to_owned()),
        fields: [
            ("title".to_owned(), "title".to_owned()),
            ("url".to_owned(), "url".to_owned()),
            ("snippet".to_owned(), "text".to_owned()),
        ]
        .into_iter()
        .collect(),
    });
    let mut tools = BTreeMap::new();
    tools.insert("web.search".to_owned(), binding);
    PluginManifest {
        id: id.to_owned(),
        name: id.to_owned(),
        version: "1.0.0".to_owned(),
        provides: vec![ProvidesEntry {
            capability: CAP_WEB_SEARCH.to_owned(),
            version: "1.0.0".to_owned(),
            selectable: true,
            default_provider: is_default,
            tools,
            ..Default::default()
        }],
        ..Default::default()
    }
}

/// The real built-in manifests, for the guards in `shipped` and `shipped_layers`.
fn builtins() -> Vec<PluginManifest> {
    crate::plugin_manifest::PluginManifestLoader::load_builtins()
}

/// The module root re-exports the split modules, so every old import path
/// (`capability_tools::verbs`, `capability_tools::map_args`, …) names the
/// split module's own item.
#[test]
fn the_root_reexports_every_split_module() {
    assert!(std::ptr::eq(super::table::verbs(), verbs()));
    let tabs = verb_by_id("browser.tabs").expect("browser.tabs is a verb");
    assert_eq!(
        super::schemas_machine::schema_browser_tabs(),
        (tabs.schema)()
    );
    assert_eq!(super::schemas::VERIFY_VERDICTS, VERIFY_VERDICTS);
    assert_eq!(
        super::defaults::layer_default_key("web.search", "limit"),
        "layer.web.search.default.limit"
    );
    assert_eq!(super::resolve::generation(), generation());
    let binding = CapabilityToolBinding {
        tool: "x.search".to_owned(),
        ..Default::default()
    };
    assert_eq!(
        super::mapping::map_args(&binding, json!({"query": "q"})),
        map_args(&binding, json!({"query": "q"}))
    );
}

mod credentials;
mod decision;
mod defaults;
mod mapping;
mod response;
mod shipped;
mod shipped_layers;
