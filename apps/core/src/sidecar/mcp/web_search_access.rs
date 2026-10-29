use std::collections::BTreeSet;

/// Node preference that controls which web and browser tools an agent can use.
pub const WEB_SEARCH_ACCESS_MODE_PREF_KEY: &str = "web-search-access-mode";

/// Search and browsing access levels shared with the desktop's Web search picker.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WebSearchAccessMode {
    Disabled,
    Cached,
    Indexed,
    #[default]
    Live,
}

impl WebSearchAccessMode {
    /// Parse the persisted preference. Unknown values are rejected at the boundary.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "disabled" => Some(Self::Disabled),
            "cached" => Some(Self::Cached),
            "indexed" => Some(Self::Indexed),
            "live" => Some(Self::Live),
            _ => None,
        }
    }

    /// Whether a canonical web or browser tool is permitted at this access level.
    pub fn allows_tool_id(self, tool_id: &str) -> bool {
        if !is_web_access_tool_id(tool_id) {
            return true;
        }

        match self {
            Self::Disabled => false,
            Self::Cached => tool_id == "web.search",
            Self::Indexed => matches!(tool_id, "web.search" | "web.extract" | "web.crawl"),
            Self::Live => true,
        }
    }
}

/// Reserved web, browser, and authenticated page-fetch tools covered by the mode.
pub fn is_web_access_tool_id(tool_id: &str) -> bool {
    tool_id.starts_with("web.")
        || tool_id.starts_with("browser.")
        || tool_id.starts_with("web_fetch.")
}

/// Provider tool ids that serve a canonical web or browser verb `mode` denies.
///
/// A direct provider tool is the same egress as its canonical verb, so a mode that
/// refuses `web.extract` must also refuse every enabled provider's `web.extract`
/// binding — the selected provider's AND every unselected one's, which the facade
/// never routes through. The set is derived from each manifest's `provides[].tools`
/// declarations (the bound `tool` plus any adapter `tools` allowlist), so tools a
/// provider exposes for other purposes are not included.
pub fn restricted_provider_tool_ids(
    manifests: &[crate::plugin_manifest::PluginManifest],
    mode: WebSearchAccessMode,
) -> BTreeSet<String> {
    let mut restricted = BTreeSet::new();
    if mode == WebSearchAccessMode::Live {
        return restricted;
    }
    for manifest in manifests {
        for provides in manifest.provided_capabilities() {
            for (verb_id, binding) in &provides.tools {
                let verb = super::canonical_tool_id(verb_id);
                if !is_web_access_tool_id(&verb) || mode.allows_tool_id(&verb) {
                    continue;
                }
                restricted.insert(super::canonical_tool_id(&binding.tool));
                if let Some(adapter) = binding.adapter.as_ref() {
                    for tool in &adapter.tools {
                        restricted.insert(super::canonical_tool_id(tool));
                    }
                }
            }
        }
    }
    restricted
}

/// Ryu Cloud Search's Core-owned manifest: the pre-installed `web.search` provider
/// that bills each search to the organization's Ryu Cloud credits. Parsed once; its
/// id is read from the manifest, so Core pins no provider-id constant.
fn cloud_search_manifest() -> &'static crate::plugin_manifest::PluginManifest {
    static MANIFEST: std::sync::OnceLock<crate::plugin_manifest::PluginManifest> =
        std::sync::OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../plugin_manifest/fixtures/cloud-search.manifest.json"
        ))
        .expect("the compiled-in cloud-search manifest parses")
    })
}

/// The Ryu Cloud Search provider id, as its Core-owned manifest declares it.
pub fn cloud_search_provider_id() -> &'static str {
    &cloud_search_manifest().id
}

/// Providers that are reachable only through their canonical layer verb, and only
/// after the user explicitly selects them. Ryu Cloud Search ships enabled so the
/// layer picker can offer it, but it spends organization credits. Its bound tool
/// must not surface as a direct agent tool while another provider is selected.
fn selected_only_manifests() -> [&'static crate::plugin_manifest::PluginManifest; 1] {
    [cloud_search_manifest()]
}

/// Whether `provider_id` is one of the [`selected_only_manifests`].
pub fn is_selected_only_provider(provider_id: &str) -> bool {
    selected_only_manifests()
        .iter()
        .any(|manifest| manifest.id == provider_id)
}

/// Whether the user explicitly picked `provider` for `capability`. An auto-pick
/// (for example, the only enabled provider after the default is disabled) does
/// not count, so a billed provider never starts spending without a choice.
pub fn explicitly_selected(
    config: &crate::plugins::binding::BindingConfig,
    capability: &str,
    provider: &str,
) -> bool {
    config
        .overrides
        .get(capability)
        .is_some_and(|chosen| chosen == provider)
}

/// Every tool a selected-only provider binds to a capability verb (the bound
/// `tool` plus any adapter `tools`), canonicalized.
pub fn selected_only_provider_tool_ids(
    manifests: &[crate::plugin_manifest::PluginManifest],
) -> BTreeSet<String> {
    let mut tools = BTreeSet::new();
    for manifest in manifests {
        if !is_selected_only_provider(&manifest.id) {
            continue;
        }
        for provides in manifest.provided_capabilities() {
            for binding in provides.tools.values() {
                tools.insert(super::canonical_tool_id(&binding.tool));
                if let Some(adapter) = binding.adapter.as_ref() {
                    for tool in &adapter.tools {
                        tools.insert(super::canonical_tool_id(tool));
                    }
                }
            }
        }
    }
    tools
}

/// Whether a resolved verb binds `tool_id` (canonical) to a selected-only
/// provider, as its bound `tool` or one of its adapter `tools`. A selected-only
/// provider resolves only through an explicit override (see
/// [`crate::plugins::binding::is_selected_only_provider`]), so this is true only
/// after the user picked it.
pub fn selected_only_tool_bound(
    verbs: &[super::capability_tools::ResolvedVerb],
    tool_id: &str,
) -> bool {
    verbs.iter().any(|resolved| {
        is_selected_only_provider(&resolved.provider_id)
            && (super::canonical_tool_id(&resolved.binding.tool) == tool_id
                || resolved.binding.adapter.as_ref().is_some_and(|adapter| {
                    adapter
                        .tools
                        .iter()
                        .any(|tool| super::canonical_tool_id(tool) == tool_id)
                }))
    })
}

/// The selected-only tool ids of the built-in manifests, parsed once. These are
/// Core-owned fixtures, so the set does not depend on the enabled plugin store
/// and stays cheap on every listing and dispatch.
pub fn builtin_selected_only_tool_ids() -> &'static BTreeSet<String> {
    static TOOLS: std::sync::OnceLock<BTreeSet<String>> = std::sync::OnceLock::new();
    TOOLS.get_or_init(|| {
        let manifests: Vec<crate::plugin_manifest::PluginManifest> =
            selected_only_manifests().into_iter().cloned().collect();
        selected_only_provider_tool_ids(&manifests)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        builtin_selected_only_tool_ids, cloud_search_provider_id, explicitly_selected,
        is_web_access_tool_id, restricted_provider_tool_ids, selected_only_provider_tool_ids,
        WebSearchAccessMode as Mode,
    };
    use crate::plugin_manifest::{
        CapabilityAdapter, CapabilityToolBinding, PluginManifest, ProvidesEntry,
    };

    fn provider(id: &str, verbs: &[(&str, &str, &[&str])]) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            provides: vec![ProvidesEntry {
                capability: "web.search".to_owned(),
                version: "1.0.0".to_owned(),
                tools: verbs
                    .iter()
                    .map(|(verb, tool, extra)| {
                        (
                            (*verb).to_owned(),
                            CapabilityToolBinding {
                                tool: (*tool).to_owned(),
                                adapter: (!extra.is_empty()).then(|| CapabilityAdapter {
                                    code: "return {};".to_owned(),
                                    tools: extra.iter().map(|t| (*t).to_owned()).collect(),
                                    ..Default::default()
                                }),
                                ..Default::default()
                            },
                        )
                    })
                    .collect(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn restricted_provider_tools_follow_each_verb_tier_and_skip_unrelated_tools() {
        let manifests = [
            provider(
                "@test/search",
                &[
                    ("web.search", "alpha.search", &["alpha.free_search"]),
                    ("web.extract", "alpha.scrape", &[]),
                ],
            ),
            provider("@test/browser", &[("browser.navigate", "beta.open", &[])]),
            provider("@test/memory", &[("memory.search", "gamma.recall", &[])]),
        ];

        let disabled = restricted_provider_tool_ids(&manifests, Mode::Disabled);
        for tool in [
            "alpha.search",
            "alpha.free_search",
            "alpha.scrape",
            "beta.open",
        ] {
            assert!(
                disabled.contains(tool),
                "{tool} must be refused when disabled"
            );
        }
        assert!(!disabled.contains("gamma.recall"));
        assert!(!disabled.contains("alpha.record"));

        let cached = restricted_provider_tool_ids(&manifests, Mode::Cached);
        assert!(!cached.contains("alpha.search"));
        assert!(cached.contains("alpha.scrape"));
        assert!(cached.contains("beta.open"));

        let indexed = restricted_provider_tool_ids(&manifests, Mode::Indexed);
        assert!(!indexed.contains("alpha.scrape"));
        assert!(indexed.contains("beta.open"));

        assert!(restricted_provider_tool_ids(&manifests, Mode::Live).is_empty());
    }

    #[test]
    fn selected_only_tools_cover_cloud_search_bindings_and_nothing_else() {
        assert_eq!(cloud_search_provider_id(), "@ryu/cloud-search");
        let manifests = [
            provider(
                cloud_search_provider_id(),
                &[("web.search", "cloudsearch.search", &["cloudsearch.extra"])],
            ),
            provider("@ryu/exa", &[("web.search", "exa.search", &[])]),
        ];
        let tools = selected_only_provider_tool_ids(&manifests);
        assert!(tools.contains("cloudsearch.search"));
        assert!(tools.contains("cloudsearch.extra"));
        assert!(!tools.contains("exa.search"));

        let builtin = builtin_selected_only_tool_ids();
        assert!(builtin.contains("cloudsearch.search"));
        assert!(!builtin.contains("exa.search"));
    }

    #[test]
    fn only_an_explicit_override_selects_a_billed_provider() {
        use crate::plugins::binding::BindingConfig;
        let cloud_id = cloud_search_provider_id();
        assert!(!explicitly_selected(
            &BindingConfig::default(),
            "web.search",
            cloud_id
        ));
        let exa = BindingConfig {
            overrides: [("web.search".to_owned(), "@ryu/exa".to_owned())].into(),
        };
        assert!(!explicitly_selected(&exa, "web.search", cloud_id));
        let cloud = BindingConfig {
            overrides: [("web.search".to_owned(), cloud_id.to_owned())].into(),
        };
        assert!(explicitly_selected(&cloud, "web.search", cloud_id));
        assert!(!explicitly_selected(&cloud, "web.extract", cloud_id));
    }

    #[test]
    fn parses_only_the_four_persisted_values() {
        assert_eq!(Mode::parse("disabled"), Some(Mode::Disabled));
        assert_eq!(Mode::parse("cached"), Some(Mode::Cached));
        assert_eq!(Mode::parse("indexed"), Some(Mode::Indexed));
        assert_eq!(Mode::parse("live"), Some(Mode::Live));
        assert_eq!(Mode::parse("future"), None);
    }

    #[test]
    fn each_mode_exposes_only_its_web_tool_tier() {
        let web_tools = [
            "web.search",
            "web.extract",
            "web.crawl",
            "web_fetch.get",
            "browser.navigate",
        ];

        assert!(web_tools.iter().all(|tool| is_web_access_tool_id(tool)));
        assert!(Mode::Disabled.allows_tool_id("memory.search"));
        assert!(!web_tools
            .iter()
            .any(|tool| Mode::Disabled.allows_tool_id(tool)));
        assert!(Mode::Cached.allows_tool_id("web.search"));
        assert!(!Mode::Cached.allows_tool_id("web.extract"));
        assert!(Mode::Indexed.allows_tool_id("web.search"));
        assert!(Mode::Indexed.allows_tool_id("web.extract"));
        assert!(Mode::Indexed.allows_tool_id("web.crawl"));
        assert!(!Mode::Indexed.allows_tool_id("web_fetch.get"));
        assert!(Mode::Live.allows_tool_id("web_fetch.get"));
        assert!(Mode::Live.allows_tool_id("browser.navigate"));
    }
}
