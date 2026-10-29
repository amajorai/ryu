//! All shipped profiles at the two production prompt composition seams.
//! These are local assembly tests, not live agent/model efficacy evidence.
use super::*;

#[tokio::test]
async fn every_shipped_profile_resolves_and_shapes_both_prompt_planes() {
    let mut manifest = crate::plugin_manifest::PluginManifest::parse_and_validate(include_str!(
        "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/manifest.json"
    ))
    .unwrap();
    crate::plugin_manifest::hydrate_manifest_code_files(&mut manifest, None).unwrap();
    let styles = &manifest.contributes.as_ref().unwrap().output_styles;
    assert_eq!(styles.len(), 12);
    let registry = ryu_output_styles::OutputStyleRegistry::empty();
    for style in styles {
        registry
            .register_plugin_style(style.id.clone(), style.source.as_deref().unwrap())
            .unwrap();
    }
    let skills_and_memory = "## Skill: Runtime fixture\n\nRemembered: keep the existing task.";
    let base = "Agent-specific base instruction.";
    let store = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    for style in styles {
        let created = store
            .create(crate::agents::CreateAgent {
                name: format!("Profile {}", style.id),
                system_prompt: Some(base.to_owned()),
                persona: Some(crate::agents::PersonaSlot {
                    output_style_id: Some(style.id.clone()),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        let persisted = store.get(&created.id).await.unwrap().unwrap();
        let resolved = resolve_output_style(
            &registry,
            None,
            persisted
                .persona
                .as_ref()
                .and_then(|persona| persona.output_style_id.as_deref()),
        )
        .unwrap();
        assert_eq!(resolved.id, style.id);
        let persisted_base = persisted.system_prompt.clone();
        assert_eq!(persisted_base.as_deref(), Some(base));
        let prefix = output_style_prefix(&resolved, persisted_base.as_deref()).unwrap();
        // The style owns the instructions on this turn, so the standalone
        // instructions layer stands down instead of sending them a second time.
        assert_eq!(
            agent_instructions_layer(persisted_base.as_deref(), true),
            None
        );
        let expected = ryu_output_styles::style_block(&resolved);
        assert_eq!(
            prefix,
            if resolved.keep_coding_instructions {
                format!("{base}\n\n{expected}")
            } else {
                expected
            }
        );
        let mut messages = vec![
            serde_json::json!({"role":"system","content":skills_and_memory}),
            serde_json::json!({"role":"user","content":"Do the requested work."}),
        ];
        prepend_system_prefix(&mut messages, &prefix);
        assert_eq!(
            messages[0]["content"],
            format!("{prefix}\n\n{skills_and_memory}")
        );
        assert_eq!(
            messages[1],
            serde_json::json!({"role":"user","content":"Do the requested work."})
        );
        let prompt = build_acp_prompt(
            merge_system_prompt(Some(skills_and_memory.to_owned()), Some(prefix.clone())),
            None,
            "Do the requested work.",
        );
        assert!(
            prompt.starts_with(&prefix),
            "{}: style must lead ACP preamble",
            style.id
        );
        assert!(prompt.contains(skills_and_memory));
        assert!(prompt.ends_with("Do the requested work."));
        assert_eq!(
            resolve_output_style(&registry, Some(&style.id), Some("missing"))
                .unwrap()
                .id,
            style.id
        );
    }
    for style in styles {
        registry.unregister_plugin_style(&style.id);
    }
    assert!(resolve_output_style(&registry, Some("eli5"), Some("concise")).is_none());
    assert!(resolve_output_style(&registry, None, None).is_none());
}
