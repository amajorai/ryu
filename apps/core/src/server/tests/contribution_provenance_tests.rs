use crate::plugin_manifest::Contributes;
use crate::server::{
    serialize_plugin_backgrounds, serialize_plugin_interfaces, tag_plugin_contribution,
};

#[test]
fn client_contributions_carry_stored_grant_provenance() {
    let tagged = tag_plugin_contribution(
        serde_json::json!({ "id": "records" }),
        "com.example.records",
        &["ui:declarative-http".to_owned()],
    );

    assert_eq!(tagged["plugin"], "com.example.records");
    assert_eq!(
        tagged["approved_grants"],
        serde_json::json!(["ui:declarative-http"])
    );
}

#[test]
fn marketplace_backgrounds_keep_their_data_and_owner_tag() {
    let background = ryu_kernel_contracts::manifest::BackgroundContribution {
        id: "@example/wallpapers:aurora".to_owned(),
        label: "Aurora".to_owned(),
        description: None,
        backdrop_id: "aurora-flow".to_owned(),
        params: Default::default(),
        attribution: "PatternCraft".to_owned(),
        attribution_url: "https://example.com/aurora".to_owned(),
    };
    let contributes = Contributes {
        backgrounds: vec![
            background.clone(),
            ryu_kernel_contracts::manifest::BackgroundContribution {
                id: "@example/wallpapers:dawn".to_owned(),
                label: "Dawn".to_owned(),
                ..background
            },
        ],
        ..Default::default()
    };
    let tag = |value| tag_plugin_contribution(value, "@example/wallpapers", &[]);
    let rows = serialize_plugin_backgrounds(&contributes, &tag, 1);

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["plugin"], "@example/wallpapers");
    assert_eq!(rows[0]["backdropId"], "aurora-flow");
    assert_eq!(rows[0]["attributionUrl"], "https://example.com/aurora");
    assert_eq!(rows[0]["approved_grants"], serde_json::json!([]));
}

#[test]
fn marketplace_interfaces_keep_their_data_and_owner_tag() {
    let interface = ryu_kernel_contracts::manifest::InterfaceContribution {
        id: "@example/pixel-town:town".to_owned(),
        label: "Pixel Town".to_owned(),
        description: None,
        renderer: "world-2d".to_owned(),
        params: std::collections::BTreeMap::from([(
            "theme".to_owned(),
            serde_json::json!("night"),
        )]),
        attribution: None,
        settings: Vec::new(),
        color_theme: Some(ryu_kernel_contracts::InterfaceColorTheme {
            light: None,
            dark: Some("ryu-dark".to_owned()),
        }),
    };
    let contributes = Contributes {
        interfaces: vec![
            interface.clone(),
            ryu_kernel_contracts::manifest::InterfaceContribution {
                id: "@example/pixel-town:city".to_owned(),
                ..interface
            },
        ],
        ..Default::default()
    };
    let tag = |value| tag_plugin_contribution(value, "@example/pixel-town", &[]);
    let rows = serialize_plugin_interfaces(&contributes, &tag, 1);

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["plugin"], "@example/pixel-town");
    assert_eq!(rows[0]["renderer"], "world-2d");
    assert_eq!(rows[0]["params"]["theme"], "night");
    assert_eq!(rows[0]["colorTheme"]["dark"], "ryu-dark");
}
