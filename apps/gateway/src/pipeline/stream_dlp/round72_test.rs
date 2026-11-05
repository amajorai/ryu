//! Round 72: envelope lanes are judged as `EnvelopeLanes` judges them on
//! both verdict paths (consecutive split candidates), so a repeated choice
//! value, a value after an empty gap and a value after a gap frame give one
//! verdict whatever the path.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn delivered_on_both(raw: &str) {
    let scanner = scanner();
    let (streamed, blocked) =
        run_streaming(raw, &offsets(raw), FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, violation) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(!blocked && violation.is_none(), "{streamed}");
    assert_eq!(streamed, buffered);
}

fn content(text: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": text } }] })
}

#[test]
fn a_repeated_choice_envelope_value_is_judged_once() {
    let mut first = content("Hi ");
    first["choices"][0]["stop_reason"] = json!("b.cc@x");
    let mut second = content("there");
    second["choices"][0]["stop_reason"] = json!("b.cc@x");
    delivered_on_both(&sse(&[first, second]));
}

#[test]
fn a_value_after_an_empty_or_missing_gap_is_judged_once() {
    let with = |text: &str, fingerprint: Option<&str>| {
        let mut frame = content(text);
        if let Some(fingerprint) = fingerprint {
            frame["system_fingerprint"] = json!(fingerprint);
        }
        frame
    };
    delivered_on_both(&sse(&[
        with("Hi ", Some("AKIA12345678")),
        with("there ", Some("")),
        with("ok", Some("AKIA12345678")),
    ]));
    delivered_on_both(&sse(&[
        with("Hi ", Some("AKIAIOSF")),
        with("there ", None),
        with("ok", Some("ODNN7EXAMPLE")),
    ]));
}

/// The envelope walk as it was before it shared one path buffer: a
/// `format!` per child, positional array segments, empty strings skipped.
fn reference_envelope_paths(value: &Value, path: String, out: &mut Vec<String>) {
    use super::envelope::pointer_token;
    match value {
        Value::String(text) if !text.is_empty() => out.push(path),
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                reference_envelope_paths(value, format!("{path}/{index}"), out);
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                let child = format!("{path}/{}", pointer_token(key));
                reference_envelope_paths(value, child, out);
            }
        }
        _ => {}
    }
}

/// `EnvelopeLanes` names every envelope string exactly as the formatted walk
/// did, and the path cap still trips only on a new path.
#[test]
fn envelope_lanes_name_paths_as_the_formatted_walk_did() {
    use super::envelope::{pointer_token, EnvelopeLanes};
    let annotations = serde_json::json!({
        "custom_blocklists": [{"id": "b1", "filtered": true}, {"id": "b/2~"}],
        "protected_material_code": {"citation": {"URL": "u", "license": ["l"]}},
        "protected_material_text": {"citation": "plain"},
    });
    let frame = serde_json::json!({
        "id": "skipped", "obfuscation": "pad", "model": "m", "": "empty key",
        "a/b": "slash", "t~e": {"k/1": ["p", "", {"z": "r", "~": "t"}], "n": 1},
        "list": [[{"index": 4, "x": "y"}], null],
        "choices": [{
            "index": 0, "stop_reason": "s", "matched_stop": "ms",
            "delta": {"content": "c", "reasoning_details": [
                {"format": "f", "id": "i", "signature": "", "data": "d"},
                {"index": 1, "format": "g"}
            ]},
            "content_filter_results": annotations.clone(),
            "content_filter_offsets": annotations,
        }],
    });
    let mut expected = Vec::new();
    for (key, value) in frame.as_object().unwrap() {
        if !matches!(key.as_str(), "choices" | "obfuscation" | "id") {
            reference_envelope_paths(value, format!("/{}", pointer_token(key)), &mut expected);
        }
    }
    let choice = &frame["choices"][0];
    for key in ["stop_reason", "matched_stop"] {
        expected.push(format!("/choices/0/{key}"));
    }
    for (index, entry) in choice["delta"]["reasoning_details"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        for field in ["format", "id", "signature", "data"] {
            if entry
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|t| !t.is_empty())
            {
                expected.push(format!(
                    "/choices/0/delta/reasoning_details/{index}/{field}"
                ));
            }
        }
    }
    for annotation in ["content_filter_results", "content_filter_offsets"] {
        let base = format!("/choices/0/{annotation}");
        let lists = &choice[annotation]["custom_blocklists"];
        reference_envelope_paths(lists, format!("{base}/custom_blocklists"), &mut expected);
        for material in ["protected_material_code", "protected_material_text"] {
            let citation = &choice[annotation][material]["citation"];
            reference_envelope_paths(
                citation,
                format!("{base}/{material}/citation"),
                &mut expected,
            );
        }
    }
    expected.sort();
    expected.dedup();
    let mut lanes = EnvelopeLanes::default();
    assert!(lanes.observe(&frame), "list[0] carries an odd index");
    assert_eq!(lanes.lane_paths(), expected);
    assert_eq!(lanes.retained_runs(), expected.len());
    assert!(lanes.take_fresh() && !lanes.overflowed());

    // At the cap, an existing path still takes a new value; a new one trips it.
    let full: serde_json::Map<String, Value> = (0..4096)
        .map(|n| (format!("k{n}"), Value::from("v")))
        .collect();
    let mut capped = EnvelopeLanes::default();
    assert!(!capped.observe(&Value::Object(full)));
    assert_eq!(capped.lane_paths().len(), 4096);
    assert!(capped.observe(&serde_json::json!({"k7": "w"})));
    assert!(!capped.overflowed() && capped.varying());
    assert!(capped.observe(&serde_json::json!({"fresh": "w"})));
    assert!(capped.overflowed() && capped.judged_by_lanes());
    assert_eq!(capped.lane_paths().len(), 4096);
}

/// The fail-closed mask as it was, reading the choice's lanes with
/// `Value::pointer_mut`.
fn reference_mask(frame: &mut Value) {
    fn strings(value: &mut Value) {
        match value {
            Value::String(text) => "[REDACTED]".clone_into(text),
            Value::Array(values) => values.iter_mut().for_each(strings),
            Value::Object(fields) => fields.values_mut().for_each(strings),
            _ => {}
        }
    }
    if let Value::Array(frames) = frame {
        frames.iter_mut().for_each(reference_mask);
        return;
    }
    if let Some(fields) = frame.as_object_mut() {
        for (key, value) in fields.iter_mut() {
            if !matches!(key.as_str(), "choices" | "id" | "obfuscation") {
                strings(value);
            }
        }
    }
    let Some(choice) = frame.pointer_mut("/choices/0") else {
        return;
    };
    for key in ["stop_reason", "matched_stop"] {
        if let Some(Value::String(text)) = choice.get_mut(key) {
            "[REDACTED]".clone_into(text);
        }
    }
    if let Some(Value::Array(details)) = choice.pointer_mut("/delta/reasoning_details") {
        for entry in details {
            for field in ["format", "id", "signature", "data"] {
                if let Some(Value::String(text)) = entry.get_mut(field) {
                    "[REDACTED]".clone_into(text);
                }
            }
        }
    }
    for annotation in ["content_filter_results", "content_filter_offsets"] {
        if let Some(lists) = choice.pointer_mut(&format!("/{annotation}/custom_blocklists")) {
            strings(lists);
        }
        for material in ["protected_material_code", "protected_material_text"] {
            if let Some(citation) =
                choice.pointer_mut(&format!("/{annotation}/{material}/citation"))
            {
                strings(citation);
            }
        }
    }
}

/// Masking every envelope string reads the choice's lanes as `pointer_mut` did.
#[test]
fn the_every_field_mask_matches_the_pointer_form() {
    use super::envelope::EnvelopeLanes;
    let annotation = json!({
        "custom_blocklists": [{"id": "b"}, "c"],
        "protected_material_code": {"citation": {"URL": "u"}},
        "protected_material_text": {"citation": ["t"]},
        "other": "kept",
    });
    let choice = json!({
        "text": "kept", "stop_reason": "s", "matched_stop": 1,
        "delta": {"content": "kept", "reasoning_details": [{"format": "f", "text": "kept"}, "x"]},
        "content_filter_results": annotation.clone(),
        "content_filter_offsets": [annotation.clone()],
    });
    let keyed = json!({"delta": {"reasoning_details": {"0": {"id": "kept"}}},
        "content_filter_results": {"protected_material_code": [{"citation": "kept"}]},
        "content_filter_offsets": {"custom_blocklists": "c", "protected_material_text": "x"}});
    let frames = [
        json!({"model": "m", "id": "i", "obfuscation": "o", "choices": [choice.clone()]}),
        json!({"choices": {"0": choice.clone()}, "nested": {"a": ["b", 1]}}),
        json!({"choices": [keyed.clone(), choice.clone()]}),
        json!({"choices": [{"delta": [{"reasoning_details": [{"id": "kept"}]}]}]}),
        json!({"choices": [[choice.clone()]]}),
        json!({"choices": [{"content_filter_results": null}], "x": null}),
        json!({"choices": "c"}),
        json!([{"choices": [choice]}, {"choices": {"0": keyed}}, "bare"]),
        json!("frame"),
    ];
    let mut masks = 0;
    for frame in frames {
        let mut expected = frame.clone();
        reference_mask(&mut expected);
        let mut masked = frame.clone();
        EnvelopeLanes::mask(&mut masked, &["*".to_owned()]);
        assert_eq!(masked, expected, "{frame}");
        masks += masked.to_string().matches("[REDACTED]").count();
    }
    assert!(masks >= 20, "{masks}");
}

/// Frame shapes for the choice, mirror and delta-field reads below.
pub(super) fn choice_shapes() -> Vec<Value> {
    let logprobs = json!({ "content": [{ "token": "a" }] });
    vec![
        json!({}),
        json!({ "choices": null }),
        json!({ "choices": "x" }),
        json!({ "choices": [] }),
        json!({ "choices": [{ "delta": { "content": "a" } }] }),
        json!({ "choices": [{ "logprobs": null }, { "logprobs": logprobs }] }),
        json!({ "choices": { "1": { "token_ids": null }, "0": { "token_ids": [1] } } }),
        json!({ "choices": [{ "delta": { "token_ids": [2], "content": "b" } }] }),
        json!({ "choices": [{ "message": { "content": "m", "token_ids": [3] } }] }),
        json!({ "choices": { "0": { "delta": { "reasoning_content": "r", "content": "c" },
            "text": "t" } } }),
        json!({ "choices": [{ "text": "t", "delta": { "reasoning": "r",
            "reasoning_details": [{ "text": "d", "summary": "s" }] } }] }),
        json!({ "choices": [[{ "delta": { "content": "nested" } }]] }),
    ]
}

/// The choices collected first, as `has_token_mirrors`/`token_ids_ahead` did.
fn reference_choices(frame: &Value) -> Vec<&Value> {
    match frame.get("choices") {
        Some(Value::Array(choices)) => choices.iter().collect(),
        Some(Value::Object(choices)) => choices.values().collect(),
        _ => Vec::new(),
    }
}

#[test]
fn token_mirror_reads_match_the_collected_choices() {
    for frame in choice_shapes() {
        let each = |pred: &dyn Fn(&Value) -> bool| {
            let mut probe = json!({ "choices": Value::Null });
            reference_choices(&frame).into_iter().any(|choice| {
                probe["choices"] = json!([choice.clone()]);
                pred(&probe)
            })
        };
        let mirrors = super::super::has_token_mirrors(&frame);
        assert_eq!(mirrors, each(&super::super::has_token_mirrors), "{frame}");
        let ahead = super::super::token_ids_ahead(&frame);
        assert_eq!(ahead, each(&super::super::token_ids_ahead), "{frame}");
    }
}

/// `Fields::observe` takes the frame's scan length from the text the stream
/// appended for it: collecting only appends, whatever came before.
#[test]
fn a_frame_scan_text_does_not_depend_on_the_text_before_it() {
    for frame in choice_shapes() {
        let mut alone = String::new();
        super::super::collect_sse_payload_text(&frame, &mut alone);
        for prefix in ["", "earlier text", "caf\u{e9}\n"] {
            let mut text = format!("{prefix}\n");
            super::super::collect_sse_payload_text(&frame, &mut text);
            assert_eq!(text[prefix.len() + 1..], alone, "{frame}");
        }
    }
}

#[test]
fn delta_fields_read_what_the_pointer_paths_read() {
    let copies = [
        super::mirror::TEXT_COPY,
        super::mirror::DETAILS_COPY,
        super::mirror::SUMMARY_COPY,
    ];
    for (tokens, copy) in super::redact::COPY_TOKENS.iter().zip(copies) {
        assert_eq!(format!("/{}", tokens.join("/")), copy);
    }
    let frames = choice_shapes();
    let paths = super::super::DELTA_TEXT_KEYS
        .iter()
        .map(|key| format!("/choices/0/delta/{key}"))
        .chain(copies.map(str::to_owned));
    let reference: Vec<String> = paths
        .map(|path| {
            frames
                .iter()
                .filter_map(|frame| frame.pointer(&path).and_then(Value::as_str))
                .collect()
        })
        .collect();
    assert_eq!(super::redact::delta_fields(&frames), reference);
    assert!(
        reference.iter().all(|field| !field.is_empty()),
        "{reference:?}"
    );
}
