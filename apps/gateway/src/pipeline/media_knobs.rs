//! Media safety knobs and weights references the hosted Gateway does not
//! forward (catalogue `media_unscreenable`).
//!
//! Replicate, Fal and BFL take the caller's body almost verbatim, so a media
//! request can switch the vendor's own safety checker off or loosen its
//! moderation from Ryu's provider account. On the fleet every such knob the
//! body names is rewritten to its safe value before dispatch. Only knobs the
//! body already carries are rewritten: the Gateway has no per-model schema, and
//! a key a model does not declare can be rejected with a 422.
//!
//! A LoRA, adapter or weights reference makes the vendor download and run
//! weights the Gateway cannot inspect, so a body that carries one is refused
//! outright. The check runs once, before routing, so no provider is chosen
//! for the request and nothing can move it to another one.
//!
//! Knob names are matched ignoring case and separators, so `safetyTolerance`
//! and `DISABLE_SAFETY_CHECKER` are rewritten like their snake_case forms. A
//! string that holds a JSON object or array (a ComfyUI `workflow_json`, a
//! stringified `params`) is decoded and screened the same way, and a knob
//! inside it is rewritten in place.

use serde_json::{Map, Value};

use crate::{custody::GatewayCustody, error::GatewayError};

/// Catalogue code for media the Gateway cannot screen.
const CODE: &str = "media_unscreenable";

const WEIGHTS_MESSAGE: &str =
    "LoRA, adapter and model weights references are not available on the hosted Gateway.";

/// File extensions of model weights and checkpoints.
const WEIGHTS_EXTENSIONS: [&str; 6] = [".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf"];

/// Words that start or end a key naming a LoRA, adapter or weights input.
const WEIGHTS_WORDS: [&str; 3] = ["lora", "adapter", "weights"];

/// Key segments that end in a weights word but name no weights input.
const NOT_WEIGHTS_SEGMENTS: [&str; 2] = ["flora", "floras"];

/// Separators of a list of references in one string (`url,url`, `url|0.8`,
/// `url;v=1`).
const REFERENCE_LIST_SEPARATORS: [char; 3] = [',', '|', ';'];

/// How many times a percent-encoded string is decoded, so `%252E` reads as `.`.
const MAX_PERCENT_DECODES: usize = 3;

/// How many levels of JSON held in a string are decoded and screened. A body
/// that still holds JSON in a string past this depth is refused: no vendor
/// decodes that many levels, and screening it would cost unbounded work.
const MAX_JSON_STRING_DEPTH: usize = 4;

/// The vendor default for `safety_tolerance` (BFL and the Flux models on
/// Replicate and Fal, where lower is stricter). It stands in for the platform
/// floor's `media.max_safety_tolerance` until that document exists.
const MAX_SAFETY_TOLERANCE: u64 = 2;

/// The `safety_filter_level` values at or above the vendor default strictness.
/// Anything else, including an unknown value, is rewritten to the default.
const SAFE_FILTER_LEVELS: [&str; 2] = ["block_low_and_above", "block_medium_and_above"];
const DEFAULT_FILTER_LEVEL: &str = "block_medium_and_above";

/// The default, stricter `moderation` value of image models that accept one.
const DEFAULT_MODERATION: &str = "auto";

/// Force every media safety knob in `body` to its safe value and refuse a body
/// that references LoRA, adapter or model weights, on a Gateway whose custody
/// screens media knobs. Every other custody passes the body through unchanged.
///
/// Returns the names of the knobs that were rewritten, for logs.
pub(super) fn enforce(
    custody: GatewayCustody,
    body: &mut Value,
) -> Result<Vec<&'static str>, GatewayError> {
    if !custody.screens_media_knobs() {
        return Ok(Vec::new());
    }
    if references_weights(body) {
        return Err(GatewayError::PlatformRefused {
            code: CODE,
            message: WEIGHTS_MESSAGE,
        });
    }
    let mut rewrites = Vec::new();
    force_safe_knobs(body, &mut rewrites);
    rewrites.sort_unstable();
    rewrites.dedup();
    Ok(rewrites)
}

/// Whether any key or string anywhere in the body references weights,
/// including inside JSON held in a string.
fn references_weights(value: &Value) -> bool {
    references_weights_at(value, 0)
}

fn references_weights_at(value: &Value, string_depth: usize) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            (is_weights_key(key) && carries_reference(value))
                || references_weights_at(value, string_depth)
        }),
        Value::Array(items) => items
            .iter()
            .any(|item| references_weights_at(item, string_depth)),
        Value::String(text) => {
            names_weights_file(text)
                || match json_in_string(text) {
                    Some(_) if string_depth >= MAX_JSON_STRING_DEPTH => true,
                    Some(inner) => references_weights_at(&inner, string_depth + 1),
                    None => false,
                }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

/// The JSON object or array a string holds, if its trimmed text is one.
/// Only text that starts with `{` or `[` is parsed, so prose costs nothing.
fn json_in_string(text: &str) -> Option<Value> {
    let text = text.trim();
    if !text.starts_with(['{', '[']) {
        return None;
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(|inner| inner.is_object() || inner.is_array())
}

/// Whether a key names a LoRA, adapter or weights input. Two readings count:
///
/// - any word of the key (split on `_`, `-`, `.`, spaces and camelCase) that
///   starts with `lora`, `adapter` or `weights`, which covers `loras`,
///   `lora_url`, `hf_lora`, `lora_weights`, `loraUrl` and `adapter_path`;
/// - any segment of the key (split on separators only, case ignored) that
///   starts or ends with one of those words, or ends with its plural, which
///   covers the `LoRA` spelling (`LoRA_url`, `hfLoRA`, `LoRAs`) and keys that
///   run the words together (`hflora`, `ipadapter`, `IPAdapter`,
///   `customweights`).
///
/// Words that merely contain those letters (`floral`, `font_weight`) do not
/// count, and neither does the English word `flora`.
fn is_weights_key(key: &str) -> bool {
    key_words(key).any(|word| WEIGHTS_WORDS.iter().any(|prefix| word.starts_with(prefix)))
        || key_segments(key).any(|segment| is_weights_segment(&segment))
}

fn is_weights_segment(segment: &str) -> bool {
    if NOT_WEIGHTS_SEGMENTS.contains(&segment) {
        return false;
    }
    let singular = segment.strip_suffix('s').unwrap_or(segment);
    WEIGHTS_WORDS.iter().any(|word| {
        segment.starts_with(word) || segment.ends_with(word) || singular.ends_with(word)
    })
}

/// The key split on `_`, `-`, `.` and spaces, each segment lowercased.
fn key_segments(key: &str) -> impl Iterator<Item = String> + '_ {
    key.split(is_key_separator)
        .filter(|segment| !segment.is_empty())
        .map(str::to_lowercase)
}

fn is_key_separator(character: char) -> bool {
    matches!(character, '_' | '-' | '.' | ' ')
}

/// The key lowercased with every separator removed, so `safetyTolerance`,
/// `Safety_Tolerance` and `safety-tolerance` all read `safetytolerance`.
fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|character| !is_key_separator(*character))
        .flat_map(char::to_lowercase)
        .collect()
}

fn key_words(key: &str) -> impl Iterator<Item = String> + '_ {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for character in key.chars() {
        if is_key_separator(character) {
            words.push(std::mem::take(&mut current));
            previous_lower = false;
            continue;
        }
        if character.is_uppercase() && previous_lower {
            words.push(std::mem::take(&mut current));
        }
        previous_lower = character.is_lowercase() || character.is_ascii_digit();
        current.extend(character.to_lowercase());
    }
    words.push(current);
    words.into_iter().filter(|word| !word.is_empty())
}

/// Whether a value under a weights key carries a reference: any non-blank
/// string leaf. Numbers, booleans and nulls are scales and switches
/// (`lora_scale: 0.8`), and an empty list names nothing.
fn carries_reference(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => items.iter().any(carries_reference),
        Value::Object(map) => map.values().any(carries_reference),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

/// Whether a string is a URL or path to a weights file. Case is ignored, and a
/// URL's query and fragment are dropped first, so `https://x/y.SafeTensors?download=1`
/// still matches. A URL is read by its path only, so a host under a matching
/// top-level domain (`https://example.pt`) does not count. Any other string
/// counts only when it is a single path with a directory (`owner/repo/model.pt`),
/// so prose that happens to end in `.pt` or `.bin` is not refused.
///
/// The string is percent-decoded first (`style%2Esafetensors`), then read as
/// a list: each item between `,`, `|` and `;` is checked on its own, so a
/// weights file followed by a scale (`url|0.8`), a parameter (`url;v=1`) or
/// another URL still counts.
fn names_weights_file(text: &str) -> bool {
    percent_decoded(text)
        .split(REFERENCE_LIST_SEPARATORS)
        .any(names_one_weights_file)
}

/// The text with every `%XX` escape decoded, repeated so a double-encoded
/// escape decodes too. Invalid escapes are kept as written.
fn percent_decoded(text: &str) -> String {
    let mut decoded = text.to_owned();
    for _ in 0..MAX_PERCENT_DECODES {
        if !decoded.contains('%') {
            break;
        }
        let bytes = decoded.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            let escaped = (bytes[index] == b'%')
                .then(|| bytes.get(index + 1..index + 3))
                .flatten()
                .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok());
            if let Some(byte) = escaped {
                out.push(byte);
                index += 3;
            } else {
                out.push(bytes[index]);
                index += 1;
            }
        }
        let next = String::from_utf8_lossy(&out).into_owned();
        if next == decoded {
            break;
        }
        decoded = next;
    }
    decoded
}

fn names_one_weights_file(text: &str) -> bool {
    let text = text.trim().to_ascii_lowercase();
    let path = match text.split_once("://") {
        Some((_, rest)) => match rest.find('/') {
            Some(slash) => &rest[slash..],
            None => return false,
        },
        None if text.contains(char::is_whitespace) || !text.contains(['/', '\\']) => {
            return false;
        }
        None => text.as_str(),
    };
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let path = path.trim_end_matches('/');
    WEIGHTS_EXTENSIONS
        .iter()
        .any(|extension| path.len() > extension.len() && path.ends_with(extension))
}

/// Rewrite every safety knob the body names, at any depth, to its safe value.
/// A string holding JSON is decoded, screened and written back only when a
/// knob inside it changed, so every other string stays byte for byte.
fn force_safe_knobs(value: &mut Value, rewrites: &mut Vec<&'static str>) {
    force_safe_knobs_at(value, rewrites, 0);
}

fn force_safe_knobs_at(value: &mut Value, rewrites: &mut Vec<&'static str>, string_depth: usize) {
    match value {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                if let Some(name) = force_knob(key, value) {
                    rewrites.push(name);
                }
                force_safe_knobs_at(value, rewrites, string_depth);
            }
        }
        Value::Array(items) => {
            for item in items {
                force_safe_knobs_at(item, rewrites, string_depth);
            }
        }
        Value::String(text) if string_depth < MAX_JSON_STRING_DEPTH => {
            let Some(mut inner) = json_in_string(text) else {
                return;
            };
            let before = rewrites.len();
            force_safe_knobs_at(&mut inner, rewrites, string_depth + 1);
            if rewrites.len() > before {
                *text = inner.to_string();
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

/// Rewrite one knob when it is not already at a safe value. The key is
/// matched ignoring case and separators. Returns the knob's snake_case name
/// when the value changed.
fn force_knob(key: &str, value: &mut Value) -> Option<&'static str> {
    let (name, safe) = match normalized_key(key).as_str() {
        "disablesafetychecker" => ("disable_safety_checker", Value::Bool(false)),
        "enablesafetychecker" => ("enable_safety_checker", Value::Bool(true)),
        "safetychecker" => match value {
            Value::Object(settings) => {
                return switch_checker_on(settings).then_some("safety_checker");
            }
            _ => ("safety_checker", Value::Bool(true)),
        },
        "safetytolerance" => ("safety_tolerance", clamped_tolerance(value)?),
        "safetyfilterlevel" => (
            "safety_filter_level",
            (!value
                .as_str()
                .is_some_and(|level| SAFE_FILTER_LEVELS.contains(&level)))
            .then(|| Value::from(DEFAULT_FILTER_LEVEL))?,
        ),
        "moderation" => (
            "moderation",
            (value.as_str() != Some(DEFAULT_MODERATION))
                .then(|| Value::from(DEFAULT_MODERATION))?,
        ),
        _ => return None,
    };
    if *value == safe {
        return None;
    }
    *value = safe;
    Some(name)
}

/// Switch an object-form safety checker (`{"enabled": false}`) on without
/// replacing the object, so any other setting in it still reaches the vendor.
/// Returns whether a setting changed.
fn switch_checker_on(settings: &mut Map<String, Value>) -> bool {
    let mut changed = false;
    for (key, value) in settings.iter_mut() {
        let safe = match normalized_key(key).as_str() {
            "enabled" | "enable" => Value::Bool(true),
            "disabled" | "disable" => Value::Bool(false),
            _ => continue,
        };
        if *value != safe {
            *value = safe;
            changed = true;
        }
    }
    changed
}

/// The clamped `safety_tolerance`, keeping the caller's type: Fal sends a
/// numeric string, BFL and Replicate a number. A value that does not parse is
/// replaced by the maximum. Returns `None` when the value is already allowed.
fn clamped_tolerance(value: &Value) -> Option<Value> {
    match value {
        Value::Number(number) => {
            let allowed = number
                .as_f64()
                .is_some_and(|tolerance| tolerance <= MAX_SAFETY_TOLERANCE as f64);
            (!allowed).then(|| Value::from(MAX_SAFETY_TOLERANCE))
        }
        Value::String(text) => {
            let allowed = text
                .trim()
                .parse::<f64>()
                .is_ok_and(|tolerance| tolerance <= MAX_SAFETY_TOLERANCE as f64);
            (!allowed).then(|| Value::from(MAX_SAFETY_TOLERANCE.to_string()))
        }
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => {
            Some(Value::from(MAX_SAFETY_TOLERANCE))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn refused_code(result: Result<Vec<&'static str>, GatewayError>) -> Option<&'static str> {
        match result {
            Err(GatewayError::PlatformRefused { code, .. }) => Some(code),
            Err(other) => panic!("unexpected error: {other}"),
            Ok(_) => None,
        }
    }

    fn fleet(mut body: Value) -> (Value, Vec<&'static str>) {
        let rewrites = enforce(GatewayCustody::Fleet, &mut body).expect("not refused");
        (body, rewrites)
    }

    #[test]
    fn fleet_refuses_weights_references_anywhere_in_the_body() {
        for body in [
            json!({ "model": "m", "input": { "prompt": "a cat", "loras": [{ "path": "https://x.invalid/y.safetensors" }] } }),
            json!({ "model": "m", "prompt": "a cat", "lora_url": "https://x.invalid/style" }),
            json!({ "model": "m", "prompt": "a cat", "hf_lora": "owner/style" }),
            json!({ "model": "m", "prompt": "a cat", "weights": "https://x.invalid/w" }),
            json!({ "model": "m", "prompt": "a cat", "lora_weights": "owner/name" }),
            json!({ "model": "m", "prompt": "a cat", "extra_lora": "owner/name" }),
            json!({ "model": "m", "prompt": "a cat", "loraUrl": "https://x.invalid/style" }),
            json!({ "model": "m", "prompt": "a cat", "adapter_path": "owner/adapter" }),
            json!({ "model": "m", "input": { "image": "https://x.invalid/a/B.SafeTensors?download=true" } }),
            json!({ "model": "m", "input": { "init": "https://x.invalid/model.ckpt#main" } }),
            json!({ "model": "m", "input": { "extra": ["owner/repo/model.pt"] } }),
            json!({ "model": "m", "input": { "extra": "C:/models/model.pth" } }),
            json!({ "model": "m", "input": { "extra": "https://x.invalid/model.bin" } }),
            json!({ "model": "m", "input": { "extra": "https://x.invalid/model.Q4.gguf" } }),
        ] {
            let mut copy = body.clone();
            assert_eq!(
                refused_code(enforce(GatewayCustody::Fleet, &mut copy)),
                Some(CODE),
                "{body}"
            );
        }
    }

    #[test]
    fn fleet_passes_bodies_without_a_weights_reference() {
        for body in [
            json!({ "model": "m", "prompt": "a cat on a bin" }),
            json!({ "model": "m", "prompt": "the logo for loja.pt" }),
            json!({ "model": "m", "prompt": "loja.pt" }),
            json!({ "model": "m", "prompt": "a cat", "lora_scale": 0.8, "loras": [] }),
            json!({ "model": "m", "prompt": "a cat", "hf_lora": "  ", "lora_url": null }),
            json!({ "model": "m", "prompt": "a cat", "font_weight": "bold", "floral": "yes" }),
            json!({ "model": "m", "image_url": "https://example.pt" }),
            json!({ "model": "m", "image_url": "https://x.invalid/cat.png?name=a.bin" }),
            json!({ "model": "m", "flora": "ferns", "colorAdjust": "warm", "loraScale": 0.5 }),
            json!({ "model": "m", "prompt": "a cat, a dog; a bird | a fish at 100%" }),
            json!({ "model": "m", "prompt": "[cat] on a mat", "params": "{\"steps\":4}" }),
            json!({ "model": "m", "image_url": "https://x.invalid/a%2Fcat.png,https://x.invalid/b.png" }),
        ] {
            let mut copy = body.clone();
            assert_eq!(
                refused_code(enforce(GatewayCustody::Fleet, &mut copy)),
                None,
                "{body}"
            );
        }
    }

    #[test]
    fn fleet_forces_every_safety_knob_to_its_safe_value() {
        let (body, rewrites) = fleet(json!({
            "model": "m",
            "disable_safety_checker": true,
            "input": {
                "disable_safety_checker": "yes",
                "enable_safety_checker": false,
                "safety_checker": false,
                "safety_tolerance": 6,
                "safety_filter_level": "block_only_high",
                "moderation": "low",
                "steps": [{ "safety_tolerance": "5" }]
            }
        }));
        assert_eq!(body["disable_safety_checker"], json!(false));
        assert_eq!(body["input"]["disable_safety_checker"], json!(false));
        assert_eq!(body["input"]["enable_safety_checker"], json!(true));
        assert_eq!(body["input"]["safety_checker"], json!(true));
        assert_eq!(body["input"]["safety_tolerance"], json!(2));
        assert_eq!(
            body["input"]["safety_filter_level"],
            json!(DEFAULT_FILTER_LEVEL)
        );
        assert_eq!(body["input"]["moderation"], json!("auto"));
        assert_eq!(body["input"]["steps"][0]["safety_tolerance"], json!("2"));
        assert_eq!(
            rewrites,
            vec![
                "disable_safety_checker",
                "enable_safety_checker",
                "moderation",
                "safety_checker",
                "safety_filter_level",
                "safety_tolerance",
            ]
        );
    }

    #[test]
    fn fleet_keeps_knobs_already_safe_and_never_inserts_one() {
        let original = json!({
            "model": "m",
            "prompt": "a cat",
            "disable_safety_checker": false,
            "enable_safety_checker": true,
            "safety_tolerance": 1,
            "safety_filter_level": "block_low_and_above",
            "moderation": "auto",
            "input": { "safety_tolerance": "2" }
        });
        let (body, rewrites) = fleet(original.clone());
        assert_eq!(body, original);
        assert!(rewrites.is_empty(), "{rewrites:?}");

        let plain = json!({ "model": "m", "prompt": "a cat" });
        let (body, rewrites) = fleet(plain.clone());
        assert_eq!(body, plain);
        assert!(rewrites.is_empty());
    }

    #[test]
    fn json_in_a_string_is_rewritten_only_when_a_knob_changes() {
        let original = json!({
            "model": "m",
            "params": "{ \"steps\": 4, \"safety_tolerance\": 1 }",
            "workflow_json": "{\"nodes\":[{\"enable_safety_checker\":false,\"seed\":7}]}"
        });
        let (body, rewrites) = fleet(original.clone());
        assert_eq!(body["params"], original["params"]);
        let workflow: Value =
            serde_json::from_str(body["workflow_json"].as_str().expect("still a string"))
                .expect("still JSON");
        assert_eq!(
            workflow,
            json!({ "nodes": [{ "enable_safety_checker": true, "seed": 7 }] })
        );
        assert_eq!(rewrites, vec!["enable_safety_checker"]);
    }

    #[test]
    fn json_nested_in_strings_past_the_limit_is_refused() {
        let mut inner = json!({ "steps": 4 });
        for _ in 0..MAX_JSON_STRING_DEPTH {
            inner = json!({ "params": inner.to_string() });
        }
        let mut within = inner.clone();
        assert_eq!(
            refused_code(enforce(GatewayCustody::Fleet, &mut within)),
            None
        );
        let mut past = json!({ "params": inner.to_string() });
        assert_eq!(
            refused_code(enforce(GatewayCustody::Fleet, &mut past)),
            Some(CODE)
        );
    }

    #[test]
    fn unparseable_tolerance_becomes_the_maximum() {
        let (body, _) = fleet(json!({
            "a": { "safety_tolerance": "lenient" },
            "b": { "safety_tolerance": null },
            "c": { "safety_tolerance": [6] },
            "d": { "safety_tolerance": 2.5 }
        }));
        assert_eq!(body["a"]["safety_tolerance"], json!("2"));
        assert_eq!(body["b"]["safety_tolerance"], json!(2));
        assert_eq!(body["c"]["safety_tolerance"], json!(2));
        assert_eq!(body["d"]["safety_tolerance"], json!(2));
    }

    #[test]
    fn other_custodies_pass_everything_unchanged() {
        let original = json!({
            "model": "m",
            "disable_safety_checker": true,
            "safety_tolerance": 6,
            "loras": [{ "path": "https://x.invalid/y.safetensors" }]
        });
        for custody in [GatewayCustody::ManagedNode, GatewayCustody::SelfHosted] {
            let mut body = original.clone();
            let rewrites = enforce(custody, &mut body).expect("not refused");
            assert_eq!(body, original, "{custody:?}");
            assert!(rewrites.is_empty(), "{custody:?}");
        }
    }

    #[test]
    fn refusal_message_never_echoes_the_request() {
        let mut body = json!({ "loras": [{ "path": "https://x.invalid/style.safetensors" }] });
        let Err(GatewayError::PlatformRefused { message, .. }) =
            enforce(GatewayCustody::Fleet, &mut body)
        else {
            panic!("expected a platform refusal");
        };
        assert!(!message.contains("x.invalid"), "{message}");
        assert!(!message.contains("style"), "{message}");
    }
}

#[cfg(test)]
#[path = "media_knobs_probe.rs"]
mod probe;
