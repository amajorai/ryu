//! Coverage probes for the fleet media knob and weights screen.
//!
//! Each probe places a harmless marker (a safety knob value, an `x.invalid`
//! URL or a weights file name) in an input shape the main tests do not cover
//! and asserts the secure outcome: the knob is rewritten or the body is
//! refused. A failing probe names a shape the screen misses.
use super::*;
use serde_json::json;

fn refused(mut body: Value) -> bool {
    matches!(
        enforce(GatewayCustody::Fleet, &mut body),
        Err(GatewayError::PlatformRefused { code: CODE, .. })
    )
}

fn screened(mut body: Value) -> Value {
    enforce(GatewayCustody::Fleet, &mut body).expect("not refused");
    body
}

fn unrefused(bodies: impl IntoIterator<Item = Value>) -> Vec<Value> {
    bodies
        .into_iter()
        .filter(|body| !refused(body.clone()))
        .collect()
}

/// Wrap `leaf` in `depth` levels of alternating objects and arrays.
fn nested(leaf: Value, depth: usize) -> Value {
    (0..depth).fold(leaf, |inner, level| {
        if level % 2 == 0 {
            json!({ "level": inner })
        } else {
            json!([{ "pad": "benign" }, inner])
        }
    })
}

fn padding(bytes: usize) -> String {
    "a calm harbour at dawn ".repeat(bytes / 23 + 1)
}

// Shapes the screen is expected to cover.

#[test]
fn probe_deep_nesting_is_screened() {
    let body = json!({ "model": "m", "input": nested(json!({ "disable_safety_checker": true, "safety_tolerance": 6 }), 100) });
    let text = screened(body).to_string();
    assert!(text.contains("\"disable_safety_checker\":false"), "{text}");
    assert!(text.contains("\"safety_tolerance\":2"), "{text}");
    assert!(refused(
        json!({ "model": "m", "input": nested(json!({ "lora_url": "https://x.invalid/style" }), 100) })
    ));
    assert!(refused(
        json!({ "model": "m", "input": nested(json!("https://x.invalid/a/style.safetensors"), 100) })
    ));
}

#[test]
fn probe_arrays_of_objects_and_arrays_of_arrays_are_screened() {
    let body = screened(json!({
        "model": "m",
        "input": {
            "tasks": [
                { "stages": [{ "prompt": "a cat" }, { "enable_safety_checker": false }] },
                [[{ "safety_tolerance": "6" }]]
            ]
        }
    }));
    assert_eq!(
        body["input"]["tasks"][0]["stages"][1]["enable_safety_checker"],
        json!(true)
    );
    assert_eq!(
        body["input"]["tasks"][1][0][0]["safety_tolerance"],
        json!("2")
    );
    for body in [
        json!({ "model": "m", "input": { "styles": [{ "name": "a" }, { "config": [{ "lora_url": "https://x.invalid/s" }] }] } }),
        json!({ "model": "m", "input": { "refs": [["https://x.invalid/a.png"], ["https://x.invalid/w/style.ckpt"]] } }),
    ] {
        assert!(refused(body.clone()), "{body}");
    }
}

#[test]
fn probe_long_padding_before_the_marker_is_screened() {
    let pad = padding(1024 * 1024);
    let body = screened(
        json!({ "model": "m", "prompt": pad, "input": { "pad": pad, "disable_safety_checker": true } }),
    );
    assert_eq!(body["input"]["disable_safety_checker"], json!(false));
    assert!(refused(
        json!({ "model": "m", "prompt": pad, "zz_lora_url": "https://x.invalid/style" })
    ));
    let long_path = format!(
        "https://x.invalid/{}/style.safetensors",
        "d".repeat(512 * 1024)
    );
    assert!(refused(
        json!({ "model": "m", "prompt": pad, "extra": long_path })
    ));
    let long_key = format!("{}_lora", "k".repeat(64 * 1024));
    assert!(refused(json!({ "model": "m", long_key: "owner/style" })));
}

#[test]
fn probe_weights_value_spellings_are_refused() {
    let missed = unrefused([
        json!({ "model": "owner/repo/style.safetensors" }),
        json!({ "model": "m", "extra": "HTTPS://X.INVALID/A/STYLE.SAFETENSORS" }),
        json!({ "model": "m", "extra": "file:///models/style.safetensors" }),
        json!({ "model": "m", "extra": "hf://owner/repo/style.safetensors" }),
        json!({ "model": "m", "extra": "s3://bucket/style.ckpt" }),
        json!({ "model": "m", "extra": "C:\\models\\style.pt" }),
        json!({ "model": "m", "extra": "  https://x.invalid/a/style.bin\n" }),
        json!({ "model": "m", "extra": "https://x.invalid/a/style.safetensors/" }),
        json!({ "model": "m", "extra": "https://x.invalid/a/style.gguf?x=1#y" }),
    ]);
    assert!(missed.is_empty(), "weights values not refused: {missed:?}");
}

#[test]
fn probe_weights_key_spellings_are_refused() {
    let missed = unrefused([
        json!({ "model": "m", "LORA_URL": "https://x.invalid/s" }),
        json!({ "model": "m", "lora-url": "https://x.invalid/s" }),
        json!({ "model": "m", "lora.url": "https://x.invalid/s" }),
        json!({ "model": "m", "lora url": "https://x.invalid/s" }),
        json!({ "model": "m", "loraWeights": "owner/style" }),
        json!({ "model": "m", "loraURL": "owner/style" }),
        json!({ "model": "m", "adapterUrl": "owner/style" }),
        json!({ "model": "m", "Adapter": "owner/style" }),
        json!({ "model": "m", "WEIGHTS": "owner/style" }),
        json!({ "model": "m", "lora2": "owner/style" }),
        json!({ "model": "m", "lora_config": "{\"path\":\"https://x.invalid/s\"}" }),
        json!({ "model": "m", "loras": { "style": { "url": "https://x.invalid/s" } } }),
    ]);
    assert!(missed.is_empty(), "weights keys not refused: {missed:?}");
}

#[test]
fn probe_duplicate_and_escaped_keys_are_screened() {
    let parsed: Value = serde_json::from_str(
        r#"{"model":"m","disable_safety_checker":false,"disable_safety_checker":true,"input":{"enable\u005fsafety\u005fchecker":false}}"#,
    )
    .expect("parses");
    let body = screened(parsed);
    assert_eq!(body["disable_safety_checker"], json!(false));
    assert_eq!(body["input"]["enable_safety_checker"], json!(true));
    let escaped: Value =
        serde_json::from_str(r#"{"model":"m","hf\u005flora":"owner/style"}"#).expect("parses");
    assert!(refused(escaped));
}

#[test]
fn probe_unusual_knob_values_are_forced_safe() {
    let body = screened(json!({
        "model": "m",
        "a": { "disable_safety_checker": "true", "safety_tolerance": "+6" },
        "b": { "disable_safety_checker": 1, "safety_tolerance": "NaN" },
        "c": { "enable_safety_checker": "false", "safety_tolerance": "inf" },
        "d": { "enable_safety_checker": 0, "safety_tolerance": 1e3 },
        "e": { "safety_checker": "off", "safety_tolerance": " 6 " },
        "f": { "safety_filter_level": "BLOCK_ONLY_HIGH", "moderation": "LOW" }
    }));
    for part in ["a", "b"] {
        assert_eq!(body[part]["disable_safety_checker"], json!(false), "{part}");
    }
    for part in ["c", "d"] {
        assert_eq!(body[part]["enable_safety_checker"], json!(true), "{part}");
    }
    assert_eq!(body["e"]["safety_checker"], json!(true));
    for part in ["a", "b", "c", "e"] {
        assert_eq!(body[part]["safety_tolerance"], json!("2"), "{part}");
    }
    assert_eq!(body["d"]["safety_tolerance"], json!(2));
    assert_eq!(
        body["f"]["safety_filter_level"],
        json!(DEFAULT_FILTER_LEVEL)
    );
    assert_eq!(body["f"]["moderation"], json!("auto"));
}

// Shapes that may slip past the screen.

/// "LoRA" is the canonical spelling. The camelCase splitter reads it as the
/// words "lo" and "ra", so no word starts with "lora".
#[test]
fn probe_lora_acronym_casing_is_refused() {
    let missed = unrefused([
        json!({ "model": "m", "LoRA": "owner/style" }),
        json!({ "model": "m", "LoRA_url": "https://x.invalid/s" }),
        json!({ "model": "m", "hfLoRA": "owner/style" }),
        json!({ "model": "m", "extraLoRA": "owner/style" }),
        json!({ "model": "m", "input": { "LoRAs": [{ "path": "https://x.invalid/s" }] } }),
    ]);
    assert!(missed.is_empty(), "LoRA-cased keys not refused: {missed:?}");
}

/// A key that runs the words together has no word starting with a prefix.
#[test]
fn probe_concatenated_weights_keys_are_refused() {
    let missed = unrefused([
        json!({ "model": "m", "hflora": "owner/style" }),
        json!({ "model": "m", "extralora": "owner/style" }),
        json!({ "model": "m", "customweights": "https://x.invalid/w" }),
        json!({ "model": "m", "ipadapter": "owner/adapter" }),
        json!({ "model": "m", "IPAdapter": "owner/adapter" }),
    ]);
    assert!(
        missed.is_empty(),
        "concatenated keys not refused: {missed:?}"
    );
}

/// A string holding JSON is only read as a whole string, so a weights
/// reference or a knob inside it is neither refused nor rewritten.
#[test]
fn probe_stringified_json_is_screened() {
    let missed = unrefused([
        json!({ "model": "m", "params": "{\"loras\":[{\"path\":\"https://x.invalid/s\"}]}" }),
        json!({ "model": "m", "params": "{\"path\":\"https://x.invalid/a/style.safetensors\"}" }),
        json!({ "model": "m", "params": "[\"https://x.invalid/a/style.safetensors\"]" }),
    ]);
    assert!(
        missed.is_empty(),
        "stringified weights not refused: {missed:?}"
    );
}

#[test]
fn probe_stringified_json_knob_is_rewritten() {
    let body = screened(json!({ "model": "m", "params": "{\"disable_safety_checker\":true}" }));
    assert!(
        !body["params"].as_str().unwrap_or_default().contains("true"),
        "stringified knob not rewritten: {body}"
    );
}

/// A weights file that is not the last token of the string, or whose
/// extension is percent-encoded, is not read as a weights file.
#[test]
fn probe_weights_file_inside_a_list_or_encoded_is_refused() {
    let missed = unrefused([
        json!({ "model": "m", "extra": "https://x.invalid/a/style.safetensors,https://x.invalid/b.png" }),
        json!({ "model": "m", "extra": "https://x.invalid/a/style.safetensors|0.8" }),
        json!({ "model": "m", "extra": "https://x.invalid/a/style%2Esafetensors" }),
        json!({ "model": "m", "extra": "https://x.invalid/a/style.safetensors;v=1" }),
    ]);
    assert!(missed.is_empty(), "weights files not refused: {missed:?}");
}

/// Knob names are matched exactly, so other spellings pass unchanged.
#[test]
fn probe_knob_spellings_are_forced_safe() {
    let body = screened(json!({
        "model": "m",
        "disableSafetyChecker": true,
        "enableSafetyChecker": false,
        "safetyTolerance": 6,
        "DISABLE_SAFETY_CHECKER": true,
        "Safety_Tolerance": 6,
        "safety_checker": { "enabled": false }
    }));
    let unsafe_left: Vec<&str> = [
        ("disableSafetyChecker", json!(true)),
        ("enableSafetyChecker", json!(false)),
        ("safetyTolerance", json!(6)),
        ("DISABLE_SAFETY_CHECKER", json!(true)),
        ("Safety_Tolerance", json!(6)),
    ]
    .iter()
    .filter(|(key, value)| body[*key] == *value)
    .map(|(key, _)| *key)
    .chain((body["safety_checker"]["enabled"] == json!(false)).then_some("safety_checker.enabled"))
    .collect();
    assert!(unsafe_left.is_empty(), "knobs left unsafe: {unsafe_left:?}");
}
