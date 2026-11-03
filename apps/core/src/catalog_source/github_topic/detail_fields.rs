//! The display allowlist lifted for the detail view.

use super::*;
use crate::catalog_source::brand_guard::is_protected_brand_name;

/// Lift the display-only allowlist off a third-party manifest. **Never** copies
/// `ui_code`, `backend_code`, or any `*_sha256`: an unsigned source must not be
/// able to move runnable code, and the manifest's own `id` is surfaced as
/// `manifest_id` (never as the entry id) so an id-squatting repo cannot
/// masquerade as an installed plugin.
///
/// Every lifted string goes through the same scrubbers the card path uses
/// ([`scrub_text`] / [`scrub_icon_id`] / [`scrub_version`]). This merge lands on
/// top of the values [`record_to_item`]'s counterpart already sanitized, so an
/// unscrubbed copy here would quietly re-open exactly what those close.
pub(crate) fn manifest_display_fields(manifest: &Value) -> serde_json::Map<String, Value> {
    manifest_display_fields_for_card(manifest, false)
}

/// [`manifest_display_fields`] for the detail view of a card that is already
/// guarded as a protected brand (by its repo slug or its marketplace entry name,
/// not only the manifest's own name): the lift then drops the declared name and
/// art too, so the detail never repaints what the card withheld.
pub(crate) fn manifest_display_fields_for_card(
    manifest: &Value,
    card_guarded: bool,
) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Some(obj) = manifest.as_object() else {
        return out;
    };
    if let Some(id) = obj
        .get("id")
        .and_then(|v| v.as_str())
        .and_then(|s| scrub_text(s, MAX_NAME_CHARS))
    {
        out.insert("manifestId".to_string(), Value::String(id));
    }
    let Some(display) = RepoManifestDisplay::from_manifest(manifest) else {
        return out;
    };
    // A declared name that reads as a protected brand is not lifted, and that
    // listing keeps none of its declared art: the card's guarded `owner/repo`
    // name and seeded tile stand. The same rule as `record_to_item`.
    let guarded = card_guarded || display.name.as_deref().is_some_and(is_protected_brand_name);
    if let Some(name) = display.name.clone().filter(|_| !guarded) {
        out.insert("manifestName".to_string(), Value::String(name));
    }
    let icon = guarded_icon_id(display.icon.clone(), guarded);
    let icon_url = display.icon_url.clone().filter(|_| !guarded);
    let insert_string =
        |out: &mut serde_json::Map<String, Value>, key: &str, value: &Option<String>| {
            if let Some(value) = value {
                out.insert(key.to_owned(), Value::String(value.clone()));
            }
        };
    insert_string(&mut out, "description", &display.description);
    insert_string(&mut out, "version", &display.version);
    insert_string(&mut out, "stability", &display.stability);
    insert_string(&mut out, "tagline", &display.tagline);
    insert_string(&mut out, "category", &display.category);
    insert_string(&mut out, "icon", &icon);
    insert_string(&mut out, "iconUrl", &icon_url);
    insert_string(&mut out, "homepage", &display.homepage);
    insert_string(&mut out, "website", &display.homepage);
    insert_string(&mut out, "repositoryUrl", &display.repository_url);
    insert_string(&mut out, "license", &display.license);
    insert_string(&mut out, "developerName", &display.developer);
    if let Some(author) = &display.author {
        out.insert("author".to_owned(), author.clone());
    }
    if let Some(icon_dither) = &display.icon_dither {
        out.insert("iconDither".to_owned(), icon_dither.clone());
    }
    if let Some(icon_background) = &display.icon_background {
        out.insert(
            "iconBackground".to_owned(),
            Value::String(icon_background.clone()),
        );
    }
    if !display.screenshots.is_empty() {
        out.insert(
            "screenshots".to_owned(),
            serde_json::json!(display.screenshots),
        );
    }
    if !display.keywords.is_empty() {
        out.insert("keywords".to_owned(), serde_json::json!(display.keywords));
    }
    if !display.tags.is_empty() {
        out.insert("tags".to_owned(), serde_json::json!(display.tags));
    } else if !display.keywords.is_empty() {
        out.insert("tags".to_owned(), serde_json::json!(display.keywords));
    }
    if !display.example_prompts.is_empty() {
        out.insert(
            "examplePrompts".to_owned(),
            serde_json::json!(display.example_prompts),
        );
    }
    if !display.capabilities.is_empty() {
        out.insert(
            "capabilities".to_owned(),
            serde_json::json!(display.capabilities),
        );
    }
    if let Some(privacy) = &display.privacy_policy_url {
        out.insert(
            "privacyPolicyUrl".to_owned(),
            Value::String(privacy.clone()),
        );
    }
    if let Some(terms) = &display.terms_of_service_url {
        out.insert("termsOfServiceUrl".to_owned(), Value::String(terms.clone()));
    }
    if display.external {
        out.insert("external".to_owned(), Value::Bool(true));
    }
    if !display.layers.is_empty() {
        out.insert("layers".to_owned(), Value::Array(display.layers.clone()));
    }
    if !display.surface_support.is_empty() {
        out.insert(
            "surfaceSupport".to_owned(),
            Value::Array(display.surface_support.clone()),
        );
    }
    for key in ["requires", "targets"] {
        if let Some(v) = obj.get(key).filter(|v| !v.is_null()) {
            out.insert(key.to_string(), v.clone());
        }
    }
    // The detail payload carries the banner too, through the SAME scrub the card
    // path uses. The hero reads the card's copy, so this is not what paints today —
    // but a list and a detail that disagree about a listing's own art is the exact
    // drift this function's doc opens by warning about.
    if let Some(banner) = display.banner.filter(|_| !guarded) {
        out.insert("banner".to_string(), banner);
    }
    // Runnable *kinds* only — the shapes, never their code.
    if let Some(runnables) = obj.get("runnables").and_then(|v| v.as_array()) {
        let kinds: Vec<Value> = runnables
            .iter()
            .filter_map(|r| r.get("kind").and_then(|v| v.as_str()))
            .map(|k| Value::String(k.to_string()))
            .collect();
        if !kinds.is_empty() {
            out.insert("runnableKinds".to_string(), Value::Array(kinds));
        }
    }
    out
}
