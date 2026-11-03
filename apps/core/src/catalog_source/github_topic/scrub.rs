//! Scrubbers for untrusted manifest text, glyph ids, colours and icon plates,
//! and the display-field lifting helpers built on them.

use super::*;

/// Strip control characters (a newline in a card title reflows the whole row) and
/// format characters (zero-width joiners, bidi overrides, tag characters, BOM,
/// soft hyphen: they reorder or hide what a title says), then bound the length.
/// `None` for a string that is empty once scrubbed.
pub(crate) fn scrub_text(value: &str, max_chars: usize) -> Option<String> {
    let cleaned: String = value
        .chars()
        .filter(|c| !c.is_control() && !is_format_char(*c))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect())
}

/// A `\p{Cf}` format character.
fn is_format_char(c: char) -> bool {
    static FORMAT: OnceLock<regex::Regex> = OnceLock::new();
    let format = FORMAT.get_or_init(|| regex::Regex::new(r"\A\p{Cf}\z").expect("static Cf regex"));
    let mut buf = [0u8; 4];
    format.is_match(c.encode_utf8(&mut buf))
}

/// An Icon-primitive glyph id from an untrusted manifest.
///
/// The client's `iconToUrl` interpolates this id into an Iconify URL path, and
/// returns a `data:` / `http(s):` id UNCHANGED — so an unconstrained string from a
/// community repo would reach a CSS `mask-image` verbatim. Restricting the
/// alphabet to what a real id uses (`lucide:heart`, `activity-03`,
/// `svgl:brave|dark`) rejects every URL and `data:` payload before it leaves Core,
/// and costs a publisher nothing: a raster logo belongs in `iconUrl`, which
/// [`sanitize_url`] already allowlists to http(s).
pub(crate) fn scrub_icon_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_ICON_ID_CHARS {
        return None;
    }
    trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.' | '|'))
        .then(|| trimmed.to_string())
}

/// A CSS colour from an untrusted manifest, for the icon square's flat background.
///
/// This one is stricter than its siblings because it lands somewhere they do not:
/// `AppIcon` puts it in an inline `style={{ background }}`, i.e. straight into CSS.
/// So the alphabet is closed rather than merely bounded — a hex literal, a bare
/// CSS colour keyword, or one colour function (`rgb`/`hsl`/`oklch`/…) whose body is
/// digits, units and separators. Everything else, `url(…)`/`expression(…)`/`;`/
/// comment syntax included, is dropped rather than sanitized: a card that renders
/// the publisher's colour is worth having, and one that renders their CSS is not.
pub(crate) fn scrub_css_color(value: &str) -> Option<String> {
    const MAX_CSS_COLOR_CHARS: usize = 64;
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_CSS_COLOR_CHARS {
        return None;
    }
    // `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`.
    if let Some(hex) = trimmed.strip_prefix('#') {
        let ok = matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
        return ok.then(|| trimmed.to_string());
    }
    // A bare keyword (`rebeccapurple`, `transparent`).
    if trimmed.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some(trimmed.to_string());
    }
    // One colour function, and nothing after its closing paren — so a value can
    // never carry a second declaration.
    let (name, rest) = trimmed.split_once('(')?;
    let known = matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "rgb" | "rgba" | "hsl" | "hsla" | "hwb" | "lab" | "lch" | "oklab" | "oklch"
    );
    let body = rest.strip_suffix(')')?;
    let body_ok = body
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | ' ' | '%' | '/' | '+' | '-'));
    (known && body_ok).then(|| trimmed.to_string())
}

/// The dithered-gradient spec from an untrusted manifest, rebuilt field by field.
///
/// Never passed through as opaque JSON: the spec reaches `DitherGradient`, which
/// paints a real gradient, so an unvalidated object from an unsigned repo is a
/// styling channel. `from`/`to` are a hue number (0–360) or a palette-colour NAME
/// (the client's `isDitherColor` is the authority on which names exist and falls
/// back on anything else — the bound here just keeps the alphabet closed);
/// `direction` is one of the four the kit accepts. Returns `None` unless at least
/// `from` survives, since the component needs it.
pub(crate) fn scrub_icon_dither(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let color = |key: &str| -> Option<Value> {
        match obj.get(key)? {
            Value::Number(n) => n
                .as_f64()
                .filter(|h| h.is_finite() && (0.0..=360.0).contains(h))
                .map(|h| Value::from(h)),
            Value::String(s) => {
                let t = s.trim();
                (!t.is_empty()
                    && t.len() <= 32
                    && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
                .then(|| Value::String(t.to_ascii_lowercase()))
            }
            _ => None,
        }
    };
    let from = color("from")?;
    let mut out = serde_json::Map::new();
    out.insert("from".to_string(), from);
    if let Some(to) = color("to") {
        out.insert("to".to_string(), to);
    }
    if let Some(direction) = obj
        .get("direction")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| matches!(s.as_str(), "up" | "down" | "left" | "right"))
    {
        out.insert("direction".to_string(), Value::String(direction));
    }
    Some(Value::Object(out))
}

pub(super) fn manifest_interface_value<'a>(
    obj: &'a serde_json::Map<String, Value>,
    interface_key: &str,
    top_level_keys: &[&str],
) -> Option<&'a Value> {
    obj.get("interface")
        .and_then(Value::as_object)
        .and_then(|interface| interface.get(interface_key))
        .filter(|value| !value.is_null())
        .or_else(|| {
            top_level_keys
                .iter()
                .find_map(|key| obj.get(*key).filter(|value| !value.is_null()))
        })
}

pub(super) fn manifest_text(
    obj: &serde_json::Map<String, Value>,
    interface_key: &str,
    top_level_keys: &[&str],
    max_chars: usize,
) -> Option<String> {
    manifest_interface_value(obj, interface_key, top_level_keys)
        .and_then(Value::as_str)
        .and_then(|value| scrub_text(value, max_chars))
}

pub(super) fn manifest_url(
    obj: &serde_json::Map<String, Value>,
    interface_key: &str,
    top_level_keys: &[&str],
) -> Option<String> {
    manifest_interface_value(obj, interface_key, top_level_keys)
        .and_then(Value::as_str)
        .and_then(sanitize_url)
}

pub(super) fn scrub_string_list(
    value: Option<&Value>,
    max_items: usize,
    max_chars: usize,
) -> Vec<String> {
    let values = match value {
        Some(Value::Array(values)) => values.iter().collect::<Vec<_>>(),
        Some(value) => vec![value],
        None => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(Value::as_str)
        .filter_map(|value| scrub_text(value, max_chars))
        .take(max_items)
        .collect()
}

pub(super) fn scrub_url_list(value: Option<&Value>) -> Vec<String> {
    scrub_string_list(value, MAX_SCREENSHOTS, MAX_URL_CHARS)
        .into_iter()
        .filter_map(|value| sanitize_url(&value))
        .collect()
}

pub(super) fn scrub_author(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(name) => scrub_text(name, MAX_NAME_CHARS).map(Value::String),
        Value::Object(author) => {
            let mut out = serde_json::Map::new();
            if let Some(name) = author
                .get("name")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_NAME_CHARS))
            {
                out.insert("name".to_owned(), Value::String(name));
            }
            if let Some(url) = author
                .get("url")
                .and_then(Value::as_str)
                .and_then(sanitize_url)
            {
                out.insert("url".to_owned(), Value::String(url));
            }
            (!out.is_empty()).then_some(Value::Object(out))
        }
        _ => None,
    }
}

pub(super) fn author_developer_string(author: &Value) -> Option<String> {
    match author {
        Value::String(name) => Some(name.clone()),
        Value::Object(author) => author
            .get("name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        _ => None,
    }
}

pub(super) fn scrub_layers(value: Option<&Value>) -> Vec<Value> {
    let Some(provides) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    provides
        .iter()
        .filter_map(|provided| {
            let object = provided.as_object()?;
            let capability = object
                .get("capability")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_CAPABILITY_CHARS))?;
            let mut layer = serde_json::Map::new();
            layer.insert("capability".to_owned(), Value::String(capability.clone()));
            if let Some(title) = object
                .get("title")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_NAME_CHARS))
            {
                layer.insert("title".to_owned(), Value::String(title));
            }
            layer.insert(
                "toolkit".to_owned(),
                Value::Bool(
                    capability == "browser.control"
                        || capability == "computer.control"
                        || capability.starts_with("web."),
                ),
            );
            if let Some(selectable) = object.get("selectable").and_then(Value::as_bool) {
                layer.insert("selectable".to_owned(), Value::Bool(selectable));
            }
            if let Some(target) = object
                .get("target")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_NAME_CHARS))
            {
                layer.insert("target".to_owned(), Value::String(target));
            }
            if let Some(tools) = object.get("tools").and_then(Value::as_object) {
                let verbs = tools
                    .keys()
                    .filter_map(|verb| scrub_text(verb, MAX_CAPABILITY_CHARS))
                    .take(MAX_LAYER_VERBS)
                    .map(Value::String)
                    .collect::<Vec<_>>();
                if !verbs.is_empty() {
                    layer.insert("verbs".to_owned(), Value::Array(verbs));
                }
            }
            Some(Value::Object(layer))
        })
        .take(MAX_LAYERS)
        .collect()
}
