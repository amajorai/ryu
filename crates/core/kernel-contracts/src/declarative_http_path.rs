//! Path rules for the declarative HTTP a host shell sends with the node's
//! credentials, on top of the manifest gate in `manifest.rs`.
//!
//! That gate tests the owner mount as a prefix of the path as written. A WHATWG
//! URL parser (Bun, Node, Electron, a browser) first drops every tab, line feed
//! and carriage return and only then resolves dot segments, so
//! `/api/ext/<id>/.<TAB>./.<TAB>./conversations` passes a prefix test and is sent
//! as `/api/conversations`.
//!
//! [`PluginManifest::validate_declarative_http_authority`] runs that gate and
//! then, for every executable `http.path`, refuses control characters and stray
//! spaces and repeats the route test on the path a URL parser produces.
//!
//! The rules live here and not in `manifest.rs` because that file is far over
//! the staged-file size limit and cannot be edited until it is split.

use url::Url;

use crate::manifest::{Contributes, PluginManifest};

/// Stand-in origin. Only the parser's path handling is used, nothing is requested.
const PARSER_BASE: &str = "http://core.invalid";
const PARSER_HOST: &str = "core.invalid";

/// Keys whose values are data, never executable configuration. The same list as
/// the walk in `manifest.rs`, so both walks see the same `http` declarations.
const OPAQUE_KEYS: &[&str] = &["http", "body", "args", "payload", "map", "filter", "cells"];

impl PluginManifest {
    /// The declarative HTTP gate Core applies at install and at every
    /// contributions read.
    ///
    /// Runs [`PluginManifest::validate_declarative_http_policy`] and then two
    /// rules that gate does not have. `allow_core_routes` has the same meaning
    /// as there. It is a provenance decision made by Core, never manifest data.
    pub fn validate_declarative_http_authority(
        &self,
        allow_core_routes: bool,
    ) -> Result<(), String> {
        self.validate_declarative_http_policy(allow_core_routes)?;
        let Some(contributes) = &self.contributes else {
            return Ok(());
        };
        for (label, value) in declarative_roots(contributes) {
            check_value(&self.id, value, allow_core_routes, &label)
                .map_err(|error| format!("plugin '{}': {error}", self.id))?;
        }
        Ok(())
    }
}

/// Every contribution that can carry an executable `source` or `http`.
fn declarative_roots(contributes: &Contributes) -> Vec<(String, &serde_json::Value)> {
    let mut roots: Vec<(String, &serde_json::Value)> = Vec::new();
    for (index, value) in contributes.composer_controls.iter().enumerate() {
        roots.push((format!("composer_controls[{index}]"), value));
    }
    for (index, view) in contributes.views.iter().enumerate() {
        if let Some(spec) = view.spec.as_ref() {
            roots.push((format!("views[{index}].spec"), spec));
        }
    }
    for (index, section) in contributes.sidebar_sections.iter().enumerate() {
        if let Some(spec) = section.spec.as_ref() {
            roots.push((format!("sidebar_sections[{index}].spec"), spec));
        }
    }
    for (index, tab) in contributes.store_tabs.iter().enumerate() {
        if let Some(spec) = tab.spec.as_ref() {
            roots.push((format!("store_tabs[{index}].spec"), spec));
        }
    }
    for (index, activity) in contributes.live_activities.iter().enumerate() {
        if let Some(spec) = activity.spec.as_ref() {
            roots.push((format!("live_activities[{index}].spec"), spec));
        }
    }
    for (index, value) in contributes.message_actions.iter().enumerate() {
        roots.push((format!("message_actions[{index}]"), value));
    }
    roots
}

fn check_value(
    plugin_id: &str,
    value: &serde_json::Value,
    allow_core_routes: bool,
    label: &str,
) -> Result<(), String> {
    match value {
        serde_json::Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                check_value(
                    plugin_id,
                    child,
                    allow_core_routes,
                    &format!("{label}[{index}]"),
                )?;
            }
        }
        serde_json::Value::Object(object) => {
            let path = object
                .get("http")
                .and_then(|http| http.get("path"))
                .and_then(serde_json::Value::as_str);
            if let Some(path) = path {
                check_path(plugin_id, path, allow_core_routes)
                    .map_err(|error| format!("{label}.http.path {error}"))?;
            }
            for (key, child) in object {
                if OPAQUE_KEYS.contains(&key.as_str()) {
                    continue;
                }
                check_value(
                    plugin_id,
                    child,
                    allow_core_routes,
                    &format!("{label}.{key}"),
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// The two rules for one path. `Err` holds the reason, without the label.
fn check_path(plugin_id: &str, path: &str, allow_core_routes: bool) -> Result<(), String> {
    if let Some(found) = forbidden_character(path) {
        return Err(format!(
            "must not contain a control character or a space (found U+{:04X})",
            found as u32
        ));
    }
    check_normalized_route(plugin_id, path, allow_core_routes)
}

/// The route test on the path a URL parser produces, not on the raw string.
fn check_normalized_route(
    plugin_id: &str,
    path: &str,
    allow_core_routes: bool,
) -> Result<(), String> {
    let normalized =
        normalized_pathname(path).ok_or_else(|| "is not a Core-relative path".to_string())?;
    if allow_core_routes {
        let is_workflow = normalized == "/workflows" || normalized.starts_with("/workflows/");
        if !normalized.starts_with("/api/") && !is_workflow {
            return Err(format!(
                "resolves to '{normalized}', which is not a Core /api/ or /workflows path"
            ));
        }
        return Ok(());
    }
    let owner_mount = format!("/api/ext/{plugin_id}");
    // An id the parser would rewrite has no stable mount to compare with.
    if normalized_pathname(&owner_mount).as_deref() != Some(owner_mount.as_str()) {
        return Err(format!(
            "cannot be confined to the owning app mount '{owner_mount}'"
        ));
    }
    if normalized != owner_mount && !normalized.starts_with(&format!("{owner_mount}/")) {
        return Err(format!(
            "resolves to '{normalized}', outside the owning app mount '{owner_mount}'"
        ));
    }
    Ok(())
}

/// The pathname a WHATWG URL parser sends for a Core-relative `path`, or `None`
/// when the result is not a plain path on the same origin.
fn normalized_pathname(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let url = Url::parse(PARSER_BASE).ok()?.join(path).ok()?;
    let same_origin = url.scheme() == "http"
        && url.host_str() == Some(PARSER_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    same_origin.then(|| url.path().to_string())
}

/// The first character a path may not hold. A control character is refused
/// everywhere. A space is refused unless it pads a `{{ token }}`, where the view
/// template grammar allows it and the host replaces the whole token.
fn forbidden_character(path: &str) -> Option<char> {
    if let Some(control) = path.chars().find(|character| character.is_control()) {
        return Some(control);
    }
    without_template_tokens(path).contains(' ').then_some(' ')
}

/// `path` with every well-formed `{{ token }}` removed.
fn without_template_tokens(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) if is_token_body(&after[..end]) => {
                out.push_str(&rest[..start]);
                rest = &after[end + 2..];
            }
            _ => {
                out.push_str(&rest[..start + 2]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A token name (letters, digits, `_`, `.`, `-`) with optional space padding.
fn is_token_body(body: &str) -> bool {
    let name = body.trim_matches(' ');
    !name.is_empty()
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
}

#[cfg(test)]
#[path = "declarative_http_path_tests.rs"]
mod tests;
