//! Banner, destination and version scrubbers for untrusted manifests.

use super::*;

/// The styles a banner may declare. `animated-gradient` is the only one that
/// selects a RENDERER (the WebGL field) rather than describing which key the
/// author meant, which is why an unknown token is dropped rather than passed on:
/// a card must not be able to name a renderer this build has never heard of.
pub(super) const BANNER_STYLES: [&str; 5] =
    ["gradient", "animated-gradient", "dither", "flat", "image"];
/// The six named looks the animated gradient ships. Anything else falls back to
/// the default on the client, so an unknown preset costs a look, not a banner.
pub(super) const BANNER_GRADIENT_PRESETS: [&str; 6] =
    ["lava", "prism", "plasma", "pulse", "vortex", "mist"];
/// The base patterns the gradient warps over.
pub(super) const BANNER_GRADIENT_SHAPES: [&str; 3] = ["checks", "stripes", "edge"];
/// A ramp is a handful of stops; a manifest declaring hundreds is not a banner.
pub(super) const MAX_BANNER_COLORS: usize = 8;

/// A finite number from an untrusted manifest, clamped into range.
///
/// The clamp is the point. These values become shader uniforms on the client, and
/// `swirlIterations: 1e6` or `scale: 1e9` is a loop the GPU runs — a frozen tab,
/// not a bad-looking listing. The client clamps again on paint (a banner can also
/// arrive from a source that never came through here); this is the near end of
/// that same guard, so a hostile value is never even cached.
pub(super) fn scrub_banner_number(value: Option<&Value>, min: f64, max: f64) -> Option<Value> {
    let n = value?.as_f64()?;
    n.is_finite().then(|| Value::from(n.clamp(min, max)))
}

/// One closed-set token, lowercased, or `None`.
pub(super) fn scrub_enum(value: Option<&Value>, allowed: &[&str]) -> Option<Value> {
    let token = value?.as_str()?.trim().to_ascii_lowercase();
    allowed
        .contains(&token.as_str())
        .then(|| Value::String(token))
}

/// The animated-gradient spec inside a banner, rebuilt field by field.
///
/// Keys are emitted in the camelCase the client's `CatalogBannerGradient`
/// declares (`shapeSize`, `swirlIterations`, `color1`) — this JSON is read by the
/// render layer, not by serde, so the snake_case spelling a Rust struct would
/// produce would arrive and paint nothing.
pub(super) fn scrub_banner_gradient(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let mut out = serde_json::Map::new();
    if let Some(preset) = scrub_enum(obj.get("preset"), &BANNER_GRADIENT_PRESETS) {
        out.insert("preset".to_string(), preset);
    }
    if let Some(shape) = scrub_enum(obj.get("shape"), &BANNER_GRADIENT_SHAPES) {
        out.insert("shape".to_string(), shape);
    }
    for key in ["color1", "color2", "color3"] {
        if let Some(color) = obj
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(scrub_css_color)
        {
            out.insert(key.to_string(), Value::String(color));
        }
    }
    // The 0-100 slider form the component's own docs use, which is what an author
    // copying those docs writes.
    for key in [
        "distortion",
        "proportion",
        "shapeSize",
        "softness",
        "speed",
        "swirl",
    ] {
        if let Some(n) = scrub_banner_number(obj.get(key), 0.0, 100.0) {
            out.insert(key.to_string(), n);
        }
    }
    if let Some(n) = scrub_banner_number(obj.get("rotation"), 0.0, 360.0) {
        out.insert("rotation".to_string(), n);
    }
    if let Some(n) = scrub_banner_number(obj.get("offset"), -100.0, 100.0) {
        out.insert("offset".to_string(), n);
    }
    if let Some(n) = scrub_banner_number(obj.get("scale"), 0.01, 4.0) {
        out.insert("scale".to_string(), n);
    }
    if let Some(n) = scrub_banner_number(obj.get("swirlIterations"), 0.0, 20.0) {
        out.insert("swirlIterations".to_string(), n);
    }
    (!out.is_empty()).then(|| Value::Object(out))
}

/// The hero banner from an untrusted manifest, rebuilt key by key.
///
/// Community listings used to lose this entirely: every icon field was lifted and
/// `banner` was not, so a repo could declare a hero and only ever get the wash
/// derived from its icon. It is presentation only — it changes how the band is
/// painted, never what the card claims about itself — and it is the same key a
/// first-party manifest declares, so one shape serves both.
///
/// TWO NARROWINGS relative to what a first-party manifest may declare, both
/// deliberate:
///
/// * `background` goes through [`scrub_css_color`], so a community banner may
///   name a COLOUR but not an arbitrary CSS background. The client's own guard is
///   a blocklist of fetching functions, which is right for a signed manifest;
///   from an unsigned repo an allowlist is cheap and a `linear-gradient` can be
///   expressed with `colors` instead.
/// * `colors` is all-or-nothing. The stops are joined into ONE ramp downstream, so
///   keeping the survivors of a rejected palette would paint a gradient the author
///   never wrote — the same rule the render layer applies.
pub(crate) fn scrub_banner(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let mut out = serde_json::Map::new();
    if let Some(style) = scrub_enum(obj.get("style"), &BANNER_STYLES) {
        out.insert("style".to_string(), style);
    }
    if let Some(bg) = obj
        .get("background")
        .and_then(|v| v.as_str())
        .and_then(scrub_css_color)
    {
        out.insert("background".to_string(), Value::String(bg));
    }
    if let Some(stops) = obj.get("colors").and_then(|v| v.as_array()) {
        let scrubbed: Vec<Value> = stops
            .iter()
            .filter_map(|c| c.as_str())
            .filter_map(scrub_css_color)
            .map(Value::String)
            .collect();
        if !stops.is_empty() && stops.len() <= MAX_BANNER_COLORS && scrubbed.len() == stops.len() {
            out.insert("colors".to_string(), Value::Array(scrubbed));
        }
    }
    // Both spellings on the way IN, camelCase on the way out — the same
    // asymmetry `iconDither` already has, and for the same reason: a manifest is
    // authored in camelCase and this cache is read back in snake_case.
    if let Some(url) = obj
        .get("imageUrl")
        .or_else(|| obj.get("image_url"))
        .and_then(|v| v.as_str())
        .and_then(sanitize_url)
    {
        out.insert("imageUrl".to_string(), Value::String(url));
    }
    if let Some(seed) = scrub_banner_number(obj.get("seed"), 0.0, f64::from(u32::MAX)) {
        out.insert("seed".to_string(), seed);
    }
    if let Some(noise) = obj.get("noise").and_then(|v| v.as_object()) {
        let mut grain = serde_json::Map::new();
        if let Some(opacity) = scrub_banner_number(noise.get("opacity"), 0.0, 100.0) {
            grain.insert("opacity".to_string(), opacity);
        }
        if let Some(scale) = scrub_banner_number(noise.get("scale"), 0.1, 10.0) {
            grain.insert("scale".to_string(), scale);
        }
        if !grain.is_empty() {
            out.insert("noise".to_string(), Value::Object(grain));
        }
    }
    if let Some(gradient) = obj.get("gradient").and_then(scrub_banner_gradient) {
        out.insert("gradient".to_string(), gradient);
    }
    (!out.is_empty()).then(|| Value::Object(out))
}

/// Does a LOOSELY-PARSED third-party manifest claim a UI destination?
///
/// The same three keys Core's typed `manifest_declares_destination` reads — a
/// `companion` runnable, a non-empty `contributes.dock_panels`, or a top-level
/// `contributes.sidebar_buttons[].target` — restated against raw JSON because a
/// community manifest is never deserialized into `PluginManifest` (one missing
/// required field on any typed member would drop the whole thing, and this path
/// must survive a manifest that is merely sloppy). The route test itself is not
/// re-implemented: it is [`crate::server::is_top_level_route`].
pub(super) fn manifest_claims_destination(obj: &serde_json::Map<String, Value>) -> bool {
    let has_companion = obj
        .get("runnables")
        .and_then(Value::as_array)
        .is_some_and(|rs| {
            rs.iter()
                .any(|r| r.get("kind").and_then(Value::as_str) == Some("companion"))
        });
    if has_companion {
        return true;
    }
    let Some(contributes) = obj.get("contributes") else {
        return false;
    };
    let has_dock_panel = contributes
        .get("dock_panels")
        .and_then(Value::as_array)
        .is_some_and(|panels| !panels.is_empty());
    if has_dock_panel {
        return true;
    }
    contributes
        .get("sidebar_buttons")
        .and_then(Value::as_array)
        .is_some_and(|buttons| {
            buttons.iter().any(|b| {
                b.get("target")
                    .and_then(Value::as_str)
                    .is_some_and(crate::server::is_top_level_route)
            })
        })
}

/// A version string from an untrusted manifest — semver's alphabet only, so the
/// version field cannot smuggle markup or a URL onto the card.
pub(crate) fn scrub_version(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_VERSION_CHARS {
        return None;
    }
    trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .then(|| trimmed.to_string())
}
