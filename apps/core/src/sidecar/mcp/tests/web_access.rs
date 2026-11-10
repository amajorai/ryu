//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use serde_json::json;

#[tokio::test]
async fn web_search_access_modes_gate_canonical_tools_from_node_preferences() -> anyhow::Result<()>
{
    let directory = tempfile::tempdir()?;
    let preferences = crate::server::preferences::PreferencesStore::open(
        directory.path().join("preferences.db"),
    )?;
    let registry = McpRegistry::empty().with_preferences(preferences.clone());

    preferences
        .set(
            web_search_access::WEB_SEARCH_ACCESS_MODE_PREF_KEY,
            "disabled",
        )
        .await?;
    assert!(registry
        .call_tool("web.search", json!({ "query": "rust" }), None)
        .await
        .is_err());

    preferences
        .set(web_search_access::WEB_SEARCH_ACCESS_MODE_PREF_KEY, "cached")
        .await?;
    assert!(registry
        .call_tool(
            "web.extract",
            json!({ "url": "https://example.test" }),
            None,
        )
        .await
        .is_err());
    let cached_search = registry
        .call_tool("web.search", json!({ "query": "rust" }), None)
        .await?;
    assert_eq!(cached_search["available"], false);

    preferences
        .set(
            web_search_access::WEB_SEARCH_ACCESS_MODE_PREF_KEY,
            "indexed",
        )
        .await?;
    assert!(registry
        .call_tool(
            "browser.navigate",
            json!({ "url": "https://example.test" }),
            None,
        )
        .await
        .is_err());
    assert!(registry
        .call_tool(
            "web.extract",
            json!({ "url": "https://example.test" }),
            None
        )
        .await?
        .get("available")
        .is_some());

    preferences
        .set(web_search_access::WEB_SEARCH_ACCESS_MODE_PREF_KEY, "live")
        .await?;
    assert!(registry
        .call_tool(
            "browser.navigate",
            json!({ "url": "https://example.test" }),
            None,
        )
        .await?
        .get("available")
        .is_some());

    Ok(())
}

#[tokio::test]
async fn web_access_mode_hides_and_refuses_unselected_provider_tools() -> anyhow::Result<()> {
    use crate::plugin_manifest::{CapabilityToolBinding, ProvidesEntry};
    let search_provider = |id: &str, tool: &str| crate::plugin_manifest::PluginManifest {
        id: id.to_owned(),
        provides: vec![ProvidesEntry {
            capability: "web.search".to_owned(),
            version: "1.0.0".to_owned(),
            tools: BTreeMap::from([(
                "web.search".to_owned(),
                CapabilityToolBinding {
                    tool: tool.to_owned(),
                    ..Default::default()
                },
            )]),
            ..Default::default()
        }],
        ..Default::default()
    };
    // Two enabled search providers and no selection: neither is the facade's
    // bound provider, so both are "unselected" direct tools.
    let store = std::sync::Arc::new(crate::plugins::PluginStore::open_in_memory()?);
    for id in ["@test/websearch-a", "@test/websearch-b"] {
        store.insert(id, "1.0.0").await?;
        store.set_enabled(id, &["tool:execute".to_owned()]).await?;
    }
    let manifests = std::sync::Arc::new(TokioRwLock::new(vec![
        search_provider("@test/websearch-a", "wsa.search"),
        search_provider("@test/websearch-b", "wsb.search"),
    ]));
    let directory = tempfile::tempdir()?;
    let preferences = crate::server::preferences::PreferencesStore::open(
        directory.path().join("preferences.db"),
    )?;
    let registry = McpRegistry::empty()
        .with_self_build(manifests, store)
        .with_preferences(preferences.clone());
    for id in ["wsa.search", "wsb.search", "wsb.record"] {
        registry.register_app_tool(id.to_owned(), id.to_owned(), None);
    }
    let listed = |tools: &[RegistryTool], id: &str| tools.iter().any(|tool| tool.id == id);
    let disabled_message = "is disabled by the node's web search access mode";

    preferences
        .set(web_search_access::WEB_SEARCH_ACCESS_MODE_PREF_KEY, "live")
        .await?;
    let tools = registry.list_all_tools().await;
    assert!(listed(&tools, "wsb.search"));
    assert!(listed(&tools, "wsb.record"));

    preferences
        .set(
            web_search_access::WEB_SEARCH_ACCESS_MODE_PREF_KEY,
            "disabled",
        )
        .await?;
    let tools = registry.list_all_tools().await;
    assert!(!listed(&tools, "wsa.search"));
    assert!(!listed(&tools, "wsb.search"));
    // An unrelated tool on the same provider is not a web provider binding.
    assert!(listed(&tools, "wsb.record"));
    for direct in ["wsb.search", "wsb__search"] {
        let refusal = registry
            .call_tool(direct, json!({ "query": "rust" }), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(refusal.contains(disabled_message), "{refusal}");
    }
    let unrelated = registry
        .call_tool("wsb.record", json!({}), None)
        .await
        .map_or_else(|error| error.to_string(), |value| value.to_string());
    assert!(!unrelated.contains(disabled_message), "{unrelated}");

    // Cached keeps web.search, so its provider bindings stay listed.
    preferences
        .set(web_search_access::WEB_SEARCH_ACCESS_MODE_PREF_KEY, "cached")
        .await?;
    assert!(listed(&registry.list_all_tools().await, "wsb.search"));
    Ok(())
}

/// The restriction half of the web access gate fails closed like the mode half:
/// a plugin-store listing error must not let an unselected provider's web tools
/// through a mode that denies them.
#[tokio::test]
async fn web_access_restriction_fails_closed_when_the_plugin_store_cannot_be_listed(
) -> anyhow::Result<()> {
    use crate::plugin_manifest::{CapabilityToolBinding, ProvidesEntry};
    let provider = crate::plugin_manifest::PluginManifest {
        id: "@test/webextract-a".to_owned(),
        provides: vec![ProvidesEntry {
            capability: "web.extract".to_owned(),
            version: "1.0.0".to_owned(),
            tools: BTreeMap::from([(
                "web.extract".to_owned(),
                CapabilityToolBinding {
                    tool: "wxa.extract".to_owned(),
                    ..Default::default()
                },
            )]),
            ..Default::default()
        }],
        ..Default::default()
    };
    let store = std::sync::Arc::new(crate::plugins::PluginStore::open_in_memory()?);
    store.insert(&provider.id, "1.0.0").await?;
    store
        .set_enabled(&provider.id, &["tool:execute".to_owned()])
        .await?;
    let manifests = std::sync::Arc::new(TokioRwLock::new(vec![provider]));
    let registry = McpRegistry::empty().with_self_build(manifests, store.clone());
    let mode = web_search_access::WebSearchAccessMode::Disabled;

    assert!(registry
        .web_access_restricted_provider_tools(mode)
        .await
        .contains("wxa.extract"));

    store.break_listing_for_test().await;
    assert!(store.list().await.is_err());
    assert!(registry
        .web_access_restricted_provider_tools(mode)
        .await
        .contains("wxa.extract"));
    // Live still restricts nothing, store error or not.
    assert!(registry
        .web_access_restricted_provider_tools(web_search_access::WebSearchAccessMode::Live)
        .await
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn unselected_cloud_search_is_neither_listed_nor_directly_callable() -> anyhow::Result<()> {
    use crate::plugin_manifest::{CapabilityToolBinding, ProvidesEntry};
    let cloud: crate::plugin_manifest::PluginManifest = serde_json::from_str(include_str!(
        "../../../plugin_manifest/fixtures/cloud-search.manifest.json"
    ))?;
    let exa = crate::plugin_manifest::PluginManifest {
        id: "@ryu/exa".to_owned(),
        provides: vec![ProvidesEntry {
            capability: "web.search".to_owned(),
            version: "1.0.0".to_owned(),
            selectable: true,
            default_provider: true,
            tools: BTreeMap::from([(
                "web.search".to_owned(),
                CapabilityToolBinding {
                    tool: "exa.search".to_owned(),
                    ..Default::default()
                },
            )]),
            ..Default::default()
        }],
        ..Default::default()
    };
    let registry_for = |manifests: Vec<crate::plugin_manifest::PluginManifest>| async move {
        let store = std::sync::Arc::new(crate::plugins::PluginStore::open_in_memory()?);
        for manifest in &manifests {
            store.insert(&manifest.id, "1.0.0").await?;
            store
                .set_enabled(&manifest.id, &["tool:execute".to_owned()])
                .await?;
        }
        let registry = McpRegistry::empty()
            .with_self_build(std::sync::Arc::new(TokioRwLock::new(manifests)), store);
        for id in ["exa.search", "cloudsearch.search"] {
            registry.register_app_tool(id.to_owned(), id.to_owned(), None);
        }
        anyhow::Ok(registry)
    };
    let listed = |tools: &[RegistryTool], id: &str| tools.iter().any(|tool| tool.id == id);

    // Exa is the default selection; Ryu Cloud Search is merely installed.
    let registry = registry_for(vec![exa.clone(), cloud.clone()]).await?;
    assert!(!listed(
        &registry.list_all_tools().await,
        "cloudsearch.search"
    ));
    for direct in ["cloudsearch.search", "cloudsearch__search"] {
        let refusal = registry
            .call_tool(direct, json!({ "query": "rust" }), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(refusal.contains(SELECTED_ONLY_TOOL_REFUSAL), "{refusal}");
    }
    assert!(
        registry
            .selected_only_tool_refused("cloudsearch.search", true)
            .await,
        "an adapter of the selected provider must not reach the billed tool"
    );
    assert!(
        !registry
            .selected_only_tool_refused("exa.search", false)
            .await
    );

    // As the only enabled provider it is still not auto-picked (exa disabled),
    // so even the facade cannot reach it until the user picks it.
    let registry = registry_for(vec![cloud.clone()]).await?;
    assert!(!listed(
        &registry.list_all_tools().await,
        "cloudsearch.search"
    ));
    assert!(
        registry
            .selected_only_tool_refused("cloudsearch.search", true)
            .await
    );
    assert!(registry
        .call_tool("cloudsearch.search", json!({ "query": "rust" }), None)
        .await
        .is_err());

    // Once explicitly picked, its resolved verb binds the tool, so the facade
    // may dispatch it. (The pure resolver is used so the test does not touch
    // the process-wide binding config.)
    let picked = crate::plugins::binding::BindingConfig {
        overrides: [(
            "web.search".to_owned(),
            web_search_access::cloud_search_provider_id().to_owned(),
        )]
        .into(),
    };
    for enabled in [vec![cloud.clone()], vec![exa, cloud]] {
        let verbs = capability_tools::resolve_verbs(&enabled, &picked);
        assert!(web_search_access::selected_only_tool_bound(
            &verbs,
            "cloudsearch.search"
        ));
        let unpicked = capability_tools::resolve_verbs(
            &enabled,
            &crate::plugins::binding::BindingConfig::default(),
        );
        assert!(!web_search_access::selected_only_tool_bound(
            &unpicked,
            "cloudsearch.search"
        ));
    }
    Ok(())
}
