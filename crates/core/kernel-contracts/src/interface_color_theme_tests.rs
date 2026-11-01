use std::collections::BTreeMap;

use super::*;
use crate::manifest::{Contributes, InterfaceContribution, ThemePreview};

const PLUGIN: &str = "@acme/pixel-town";
const INTERFACE: &str = "@acme/pixel-town:town";

fn theme(id: &str, mode: &str) -> ThemeContribution {
    ThemeContribution {
        id: id.to_owned(),
        label: "Pixel".to_owned(),
        mode: mode.to_owned(),
        preview: ThemePreview {
            bg: "#000".to_owned(),
            surface: "#111".to_owned(),
            primary: "#f0f".to_owned(),
            text: "#fff".to_owned(),
        },
        tokens: BTreeMap::from([("--radius".to_owned(), "0px".to_owned())]),
    }
}

fn own_themes() -> Vec<ThemeContribution> {
    vec![
        theme("@acme/pixel-town:day", "light"),
        theme("@acme/pixel-town:night", "dark"),
    ]
}

fn slots(light: Option<&str>, dark: Option<&str>) -> InterfaceColorTheme {
    InterfaceColorTheme {
        light: light.map(str::to_owned),
        dark: dark.map(str::to_owned),
    }
}

fn check(color_theme: &InterfaceColorTheme) -> Result<(), String> {
    validate_interface_color_theme(PLUGIN, INTERFACE, color_theme, &own_themes())
}

#[test]
fn accepts_same_plugin_themes_with_matching_mode() {
    assert!(check(&slots(
        Some("@acme/pixel-town:day"),
        Some("@acme/pixel-town:night")
    ))
    .is_ok());
    assert!(check(&slots(None, Some("@acme/pixel-town:night"))).is_ok());
    assert!(check(&slots(Some("@acme/pixel-town:day"), None)).is_ok());
}

#[test]
fn accepts_builtin_preset_ids() {
    assert!(check(&slots(Some("ryu-light"), Some("ryu-dark"))).is_ok());
    assert!(check(&slots(None, Some("0-mono"))).is_ok());
    let longest = "a".repeat(64);
    assert!(check(&slots(Some(&longest), None)).is_ok());
}

#[test]
fn rejects_an_empty_color_theme() {
    let error = check(&slots(None, None)).expect_err("empty colorTheme");
    assert!(error.contains(INTERFACE), "{error}");
}

#[test]
fn rejects_foreign_namespaces_and_missing_themes() {
    assert!(check(&slots(Some("@other/themes:day"), None)).is_err());
    assert!(check(&slots(None, Some("ryu:dark"))).is_err());
    // The plugin's own namespace with no local id, or a theme it never ships.
    assert!(check(&slots(Some("@acme/pixel-town:"), None)).is_err());
    assert!(check(&slots(Some("@acme/pixel-town:dusk"), None)).is_err());
    // A prefix of the plugin id is still another namespace.
    assert!(check(&slots(Some("@acme/pixel:day"), None)).is_err());
}

#[test]
fn rejects_a_mode_mismatch() {
    assert!(check(&slots(Some("@acme/pixel-town:night"), None)).is_err());
    assert!(check(&slots(None, Some("@acme/pixel-town:day"))).is_err());
}

#[test]
fn same_plugin_ids_allow_any_non_control_character() {
    // The client parser applies the same rule: no control characters, any other
    // character in the local part.
    let spaced = "@acme/pixel-town:Night Mode é";
    let mut themes = own_themes();
    themes.push(theme(spaced, "dark"));
    themes.push(theme("@acme/pixel-town:next\u{85}line", "dark"));
    let validate = |id: &str| {
        validate_interface_color_theme(PLUGIN, INTERFACE, &slots(None, Some(id)), &themes)
    };
    assert!(validate(spaced).is_ok());
    assert!(validate("@acme/pixel-town:next\u{85}line").is_err());
}

#[test]
fn rejects_malformed_ids() {
    let oversized = format!(
        "{PLUGIN}:{}",
        "a".repeat(MAX_INTERFACE_COLOR_THEME_ID_BYTES)
    );
    let mut themes = own_themes();
    themes.push(theme(&oversized, "light"));
    assert!(validate_interface_color_theme(
        PLUGIN,
        INTERFACE,
        &slots(Some(&oversized), None),
        &themes
    )
    .is_err());
    assert!(check(&slots(Some("ryu-dark\n"), None)).is_err());
    assert!(check(&slots(Some("  "), None)).is_err());
    assert!(check(&slots(Some(""), None)).is_err());
    // Built-in ids are lowercase `[a-z0-9-]`, at most 64 characters.
    assert!(check(&slots(Some("Ryu-Dark"), None)).is_err());
    assert!(check(&slots(Some("-dark"), None)).is_err());
    assert!(check(&slots(Some(&"a".repeat(65)), None)).is_err());
    assert!(check(&slots(Some("@acme/pixel-town"), None)).is_err());
}

fn interface_from(wire: serde_json::Value) -> InterfaceContribution {
    serde_json::from_value(wire).expect("interface deserializes")
}

#[test]
fn wire_field_is_camel_case_and_omitted_when_absent() {
    let base = serde_json::json!({
        "id": INTERFACE,
        "label": "Pixel Town",
        "renderer": "world-2d",
    });
    let plain = interface_from(base.clone());
    assert!(plain.color_theme.is_none());
    let wire = serde_json::to_value(&plain).expect("serializes");
    assert!(wire.get("colorTheme").is_none());
    assert!(wire.get("color_theme").is_none());

    let mut themed = base;
    themed["colorTheme"] = serde_json::json!({ "dark": "@acme/pixel-town:night" });
    let interface = interface_from(themed);
    assert_eq!(
        interface.color_theme,
        Some(slots(None, Some("@acme/pixel-town:night")))
    );
    let wire = serde_json::to_value(&interface).expect("serializes");
    assert_eq!(wire["colorTheme"]["dark"], "@acme/pixel-town:night");
    assert!(wire["colorTheme"].get("light").is_none());
}

#[test]
fn validate_interfaces_checks_the_color_theme() {
    let with = |color_theme: InterfaceColorTheme| Contributes {
        themes: own_themes(),
        interfaces: vec![InterfaceContribution {
            color_theme: Some(color_theme),
            ..interface_from(serde_json::json!({
                "id": INTERFACE,
                "label": "Pixel Town",
                "renderer": "world-2d",
            }))
        }],
        ..Default::default()
    };
    assert!(with(slots(Some("@acme/pixel-town:day"), Some("ryu-dark")))
        .validate_interfaces(PLUGIN)
        .is_ok());
    assert!(with(slots(Some("@other/themes:day"), None))
        .validate_interfaces(PLUGIN)
        .is_err());
    assert!(with(slots(None, None)).validate_interfaces(PLUGIN).is_err());
}
