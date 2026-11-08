//! Decision verbs and the effect metadata every verb carries.

use super::*;

#[test]
fn decision_predict_is_a_read_only_swappable_verb() {
    use super::*;

    let verb = verbs()
        .iter()
        .find(|verb| verb.id == "decision.predict")
        .expect("the typed decision facade is registered");
    let schema = (verb.schema)();
    assert_eq!(verb.server, SERVER_DECISION);
    assert_eq!(verb.capability, CAP_DECISION_TYPED);
    assert_eq!(
        schema["required"],
        serde_json::json!(["state", "questions"])
    );
    assert!(schema["properties"]["model"].is_object());
    assert!(schema["properties"]["images"].is_null());
    assert!(schema["properties"]["task"].is_null());
    assert!(schema["properties"]["lang"].is_null());
    assert_eq!(
        verb_annotations(verb.id).as_ref().unwrap()["readOnlyHint"],
        true
    );
    assert!(is_server(SERVER_DECISION));
}

#[test]
fn multimodal_decision_verb_is_advertised_only_by_providers_that_declare_it() {
    use super::*;
    use crate::plugin_manifest::{ProvidesEntry, ProvidesLayerKind};
    use crate::plugins::binding::BindingConfig;

    let verb = verbs()
        .iter()
        .find(|verb| verb.id == "decision.predict_multimodal")
        .expect("the multimodal decision facade is registered");
    let schema = (verb.schema)();
    assert_eq!(verb.server, SERVER_DECISION);
    assert_eq!(verb.capability, CAP_DECISION_TYPED);
    assert_eq!(schema["properties"]["images"]["maxItems"], 4);
    assert_eq!(
        schema["required"],
        serde_json::json!(["state", "questions"])
    );

    let mut text_tools = BTreeMap::new();
    text_tools.insert(
        "decision.predict".to_owned(),
        CapabilityToolBinding {
            tool: "text.predict".to_owned(),
            ..Default::default()
        },
    );
    let mut image_tools = text_tools.clone();
    image_tools.insert(
        "decision.predict_multimodal".to_owned(),
        CapabilityToolBinding {
            tool: "image.predict".to_owned(),
            ..Default::default()
        },
    );

    fn provider(tools: BTreeMap<String, CapabilityToolBinding>) -> PluginManifest {
        PluginManifest {
            id: "@ryu/provider".to_owned(),
            provides: vec![ProvidesEntry {
                capability: CAP_DECISION_TYPED.to_owned(),
                title: Some("Typed Decisions".to_owned()),
                version: "1.0.0".to_owned(),
                selectable: true,
                default_provider: true,
                layer_kind: Some(ProvidesLayerKind::DecisionModel),
                tools,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    let config = BindingConfig::default();
    assert!(!resolve_verbs(&[provider(text_tools)], &config)
        .iter()
        .any(|item| item.verb.id == "decision.predict_multimodal"));
    assert!(resolve_verbs(&[provider(image_tools)], &config)
        .iter()
        .any(|item| item.verb.id == "decision.predict_multimodal"));
}

#[test]
fn decision_predict_routes_through_the_selected_provider() {
    use super::*;
    use crate::plugin_manifest::{ProvidesEntry, ProvidesLayerKind};
    use crate::plugins::binding::BindingConfig;

    fn provider(id: &str, tool: &str, is_default: bool) -> PluginManifest {
        let mut tools = BTreeMap::new();
        tools.insert(
            "decision.predict".to_owned(),
            CapabilityToolBinding {
                tool: tool.to_owned(),
                ..Default::default()
            },
        );
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            provides: vec![ProvidesEntry {
                capability: CAP_DECISION_TYPED.to_owned(),
                title: Some("Typed Decisions".to_owned()),
                version: "1.0.0".to_owned(),
                selectable: true,
                default_provider: is_default,
                layer_kind: Some(ProvidesLayerKind::DecisionModel),
                tools,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    let providers = vec![
        provider("@ryu/laya", "laya.predict", true),
        provider("@ryu/ollaya", "ollaya.predict", false),
    ];
    let config = BindingConfig {
        overrides: [(CAP_DECISION_TYPED.to_owned(), "@ryu/ollaya".to_owned())]
            .into_iter()
            .collect(),
    };
    let resolved = resolve_verbs(&providers, &config);
    let decision = resolved
        .iter()
        .find(|item| item.verb.id == "decision.predict")
        .expect("the selected provider serves decision.predict");

    assert_eq!(decision.provider_id, "@ryu/ollaya");
    assert_eq!(decision.binding.tool, "ollaya.predict");
}

#[test]
fn every_canonical_verb_has_explicit_effect_metadata() {
    use crate::agent_execution::{classify_tool_with_metadata, ToolEffect};
    for verb in super::verbs() {
        let annotations = super::verb_annotations(verb.id)
            .unwrap_or_else(|| panic!("missing effect contract for {}", verb.id));
        let effect = classify_tool_with_metadata(verb.id, Some(&annotations), None);
        assert_ne!(effect, ToolEffect::Unknown, "{}", verb.id);
    }
    for id in [
        "browser.type",
        "browser.click",
        "browser.navigate",
        "computer.key",
        "memory.store",
        "web.crawl",
    ] {
        assert_eq!(
            classify_tool_with_metadata(id, super::verb_annotations(id).as_ref(), None),
            ToolEffect::Mutate,
            "{id}"
        );
    }
    for id in [
        "browser.snapshot",
        "computer.capture",
        "web.search",
        "memory.search",
    ] {
        assert_eq!(
            classify_tool_with_metadata(id, super::verb_annotations(id).as_ref(), None),
            ToolEffect::Read,
            "{id}"
        );
    }
    assert!(super::verb_annotations("browser.future_verb").is_none());
}

#[test]
fn advertised_verbs_carry_effects_to_the_agent_gate() {
    let provider = search_provider("@ryu/test", true, "test.search");
    let resolved = super::resolve_verbs(&[provider], &Default::default());
    let tools = super::tools(&resolved);
    assert!(!tools.is_empty());
    assert!(tools.iter().all(|tool| {
        tool.annotations
            .as_ref()
            .is_some_and(|a| a["readOnlyHint"] == true)
    }));
}
