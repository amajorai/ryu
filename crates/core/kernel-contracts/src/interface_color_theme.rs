//! The optional **colour theme** a Marketplace interface ships with
//! (`contributes.interfaces[].colorTheme`).
//!
//! An interface can name one colour theme per mode. While it is the active
//! interface, the desktop shell paints that theme as a temporary override: it
//! never writes the user's saved presets, and the user's own preset fills any mode
//! the interface leaves out, any theme the host cannot resolve, and every other
//! interface.
//!
//! # Why `colorTheme`, not `theme`
//!
//! `params.theme` is already a renderer knob (the world renderers' look), and the
//! value `"theme"` means "follow the colour theme" for some renderers. A second
//! field called `theme` would collide with both.
//!
//! # What a slot may name
//!
//! - a theme the **same** plugin contributes in `contributes.themes`
//!   (`"<plugin-id>:<local-id>"`), whose `mode` equals the slot; or
//! - a **built-in** preset id (un-namespaced, e.g. `"ryu-dark"`). The host resolves
//!   it and falls back to the user's own preset when it is unknown, so the manifest
//!   boundary checks only its shape.
//!
//! Every id is at most 128 UTF-8 bytes with no control characters; any other
//! character is allowed in a same-plugin id. The client parser
//! (`packages/protocol/src/interface-color-theme.ts`) applies the same rule.
//!
//! A namespaced id naming another plugin is rejected: an interface must not depend
//! on a theme a different publisher can change or remove.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::manifest::ThemeContribution;

/// Longest theme id one colour-theme slot may name, in UTF-8 bytes.
pub const MAX_INTERFACE_COLOR_THEME_ID_BYTES: usize = 128;

/// Longest built-in preset id a slot may name (the `[a-z0-9-]` form).
const MAX_BUILTIN_PRESET_ID_LEN: usize = 64;

/// The colour theme an interface paints while it is active, one optional slot per
/// mode. At least one slot must be present.
///
/// ```json
/// "colorTheme": { "light": "@acme/pixel-town:day", "dark": "@acme/pixel-town:night" }
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InterfaceColorTheme {
    /// Theme painted in light mode: a theme this plugin contributes with
    /// `mode: "light"` (`"<plugin-id>:<local-id>"`), or a built-in preset id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light: Option<String>,
    /// Theme painted in dark mode: a theme this plugin contributes with
    /// `mode: "dark"` (`"<plugin-id>:<local-id>"`), or a built-in preset id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark: Option<String>,
}

/// Whether `id` has the shape of a built-in preset id (`^[a-z0-9][a-z0-9-]{0,63}$`).
fn is_builtin_preset_id(id: &str) -> bool {
    id.len() <= MAX_BUILTIN_PRESET_ID_LEN
        && id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Check one mode slot against the rules in the module docs.
fn validate_slot(
    plugin_id: &str,
    interface_id: &str,
    mode: &str,
    theme_id: &str,
    themes: &[ThemeContribution],
) -> Result<(), String> {
    if theme_id.trim().is_empty()
        || theme_id.len() > MAX_INTERFACE_COLOR_THEME_ID_BYTES
        || theme_id.chars().any(char::is_control)
    {
        return Err(format!(
            "interface '{interface_id}' colorTheme.{mode} must be a non-empty theme id of at most {MAX_INTERFACE_COLOR_THEME_ID_BYTES} bytes without control characters"
        ));
    }
    if !theme_id.contains(':') {
        if is_builtin_preset_id(theme_id) {
            return Ok(());
        }
        return Err(format!(
            "interface '{interface_id}' colorTheme.{mode} '{theme_id}' must be a built-in preset id or a theme this plugin contributes"
        ));
    }
    let prefix = format!("{plugin_id}:");
    if theme_id.strip_prefix(&prefix).is_none_or(str::is_empty) {
        return Err(format!(
            "interface '{interface_id}' colorTheme.{mode} '{theme_id}' must name a theme in this plugin's namespace '{prefix}'"
        ));
    }
    let Some(theme) = themes.iter().find(|theme| theme.id == theme_id) else {
        return Err(format!(
            "interface '{interface_id}' colorTheme.{mode} '{theme_id}' is not a theme this plugin contributes"
        ));
    };
    if theme.mode != mode {
        return Err(format!(
            "interface '{interface_id}' colorTheme.{mode} '{theme_id}' is a {} theme",
            theme.mode
        ));
    }
    Ok(())
}

/// Validate an interface's `colorTheme` against its plugin's own `themes`.
///
/// `plugin_id` is the owning plugin, `interface_id` only labels error messages,
/// and `themes` is that plugin's `contributes.themes`.
pub fn validate_interface_color_theme(
    plugin_id: &str,
    interface_id: &str,
    color_theme: &InterfaceColorTheme,
    themes: &[ThemeContribution],
) -> Result<(), String> {
    if color_theme.light.is_none() && color_theme.dark.is_none() {
        return Err(format!(
            "interface '{interface_id}' colorTheme must name a light or dark theme"
        ));
    }
    for (mode, slot) in [("light", &color_theme.light), ("dark", &color_theme.dark)] {
        if let Some(theme_id) = slot.as_deref() {
            validate_slot(plugin_id, interface_id, mode, theme_id, themes)?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "interface_color_theme_tests.rs"]
mod tests;
