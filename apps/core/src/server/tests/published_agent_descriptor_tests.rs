use crate::agents::AgentIdentityMode;
use crate::server::published_agent_descriptor_to_template;
use serde_json::json;

fn descriptor(extra: serde_json::Value) -> serde_json::Value {
    let mut base = json!({
        "display_name": "Researcher",
        "system_prompt": "You research.",
    });
    base.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    base
}

#[test]
fn the_publishers_identity_mode_travels_with_the_descriptor() {
    for mode in ["managed", "individual", "mixed"] {
        let template = published_agent_descriptor_to_template(
            &descriptor(json!({ "identity_mode": mode })),
            "listing",
        )
        .unwrap();
        assert_eq!(template.agent_config.identity_mode.as_str(), mode);
        let (_, requires) = template.sanitize_for_untrusted_install();
        assert_eq!(
            requires.identity_mode.map(AgentIdentityMode::as_str),
            Some(mode)
        );
    }
    let legacy = published_agent_descriptor_to_template(&descriptor(json!({})), "listing").unwrap();
    assert_eq!(
        legacy.agent_config.identity_mode,
        AgentIdentityMode::Managed
    );
}

#[test]
fn an_unknown_identity_mode_is_refused_not_defaulted() {
    for bad in [
        json!("owner"),
        json!(""),
        json!(1),
        json!({ "mode": "mixed" }),
    ] {
        assert!(
            published_agent_descriptor_to_template(
                &descriptor(json!({ "identity_mode": bad })),
                "listing",
            )
            .is_err(),
            "{bad} must not install"
        );
    }
    // A template that failed to decode must not be re-read as a descriptor.
    let template = json!({
        "kind": "agent",
        "name": "Researcher",
        "agent_config": { "identity_mode": "owner" },
    });
    assert!(serde_json::from_value::<crate::agents::AgentTemplate>(template.clone()).is_err());
    assert!(published_agent_descriptor_to_template(&template, "listing").is_err());
}
