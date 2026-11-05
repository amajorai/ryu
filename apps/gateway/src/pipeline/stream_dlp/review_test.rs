//! Regression cases from the adversarial review of text-level redaction.

use serde_json::Value;

use super::scan_test::{provider_frame, run_streaming, scanner, splits};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn visible(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn frames(parts: &[&str], last: Option<Value>) -> String {
    let mut raw = String::new();
    for (index, part) in parts.iter().enumerate() {
        raw.push_str(&provider_frame(index, part));
    }
    if let Some(last) = last {
        raw.push_str(&format!("data: {last}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    raw
}

/// The per-string fallback must not release the tail of a value whose head
/// matches on its own (exact check, not "nothing still matches").
#[test]
fn per_string_fallback_never_releases_the_tail_of_a_value() {
    let scanner = scanner();
    let odd_finish =
        serde_json::json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "eos-1" }] });
    let raw = frames(
        &["token ghp_abcdefghijklmnopqrstuvwxyz0123", "456789 ok"],
        Some(odd_finish),
    );
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let (streamed, _) = run_streaming(&raw, &[], policy.clone(), &scanner).unwrap();
        assert!(
            !visible(&streamed).contains("456789"),
            "{policy:?} streamed"
        );
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(
            !visible(&buffered).contains("456789"),
            "{policy:?} buffered"
        );
    }
}

/// Private-use characters in the answer (the Apple logo, icon-font glyphs) do
/// not disable the text-level split.
#[test]
fn private_use_characters_keep_the_text_level_split() {
    let scanner = scanner();
    let parts = [
        "Made on a Mac \u{F8FF} \u{E000} by the team. ",
        "Contact jane.d",
        "oe@example.com",
        " for details. ",
    ];
    let raw = frames(&parts, None);
    let (streamed, _) = run_streaming(&raw, &[], FirewallPolicy::Sanitize, &scanner).unwrap();
    let text = visible(&streamed);
    assert!(
        text.contains("Contact [REDACTED:EMAIL] for details."),
        "{text}"
    );
    assert!(text.contains('\u{F8FF}'));
}

/// Padding-only text cannot pin the scan start: held text stays bounded.
#[test]
fn padding_heavy_responses_keep_the_scan_region_bounded() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    for index in 0..4000 {
        let frame = provider_frame(index, "# - # ");
        dlp.push(frame.as_bytes(), &scanner).unwrap();
    }
    assert!(
        dlp.text.len() < 16 * 1024,
        "retained {} bytes",
        dlp.text.len()
    );
}

/// Zero-width characters the scan strips cannot stretch a bounded match past
/// the release lag, and zero-width-only tokens count as padding.
#[test]
fn zero_width_characters_do_not_stretch_bounded_or_padded_matches() {
    let scanner = scanner();
    let gap = "\u{200B}".repeat(120);
    let card = format!("4111{gap}1111{gap}1111{gap}1111");
    let mut lead = vec!["context "; 40];
    lead.push("card: ");
    let mut parts: Vec<String> = lead.iter().map(|part| (*part).to_owned()).collect();
    for chunk in card.chars().collect::<Vec<_>>().chunks(5) {
        parts.push(chunk.iter().collect());
    }
    parts.push(" thanks".to_owned());
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    let raw = frames(&refs, None);
    let (streamed, blocked) =
        run_streaming(&raw, &splits(&raw, 3, 40), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "zero-width padded card not blocked");
    assert!(!visible(&streamed).contains("4111"));

    let zw_token = "\u{200B}\u{200C} ";
    let mut padded = vec!["intro ".repeat(20), "My passport ".to_owned()];
    padded.extend(std::iter::repeat_n(zw_token.to_owned(), 4));
    padded.extend(std::iter::repeat_n("# ".to_owned(), 300));
    padded.push("AB1234567 end".to_owned());
    let refs: Vec<&str> = padded.iter().map(String::as_str).collect();
    let raw = frames(&refs, None);
    let offsets: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    let (streamed, _) = run_streaming(&raw, &offsets, FirewallPolicy::Block, &scanner).unwrap();
    assert!(!visible(&streamed).contains("AB1234567"));
}

/// Frames whose `choices`, choice, `delta` or `reasoning_details` take every
/// shape `Value::pointer` treats differently.
fn pointer_shapes() -> Vec<Value> {
    let entry = serde_json::json!({ "text": "t", "summary": "s" });
    let delta = serde_json::json!({
        "content": "c", "reasoning": "r", "reasoning_content": "rc",
        "reasoning_details": [entry.clone()],
    });
    let keyed = serde_json::json!({ "reasoning": "", "reasoning_details": { "0": entry } });
    [
        serde_json::json!({ "choices": [{ "text": "t", "delta": delta.clone() }] }),
        serde_json::json!({ "choices": { "0": { "text": "t", "delta": delta.clone() } } }),
        serde_json::json!({ "choices": { "00": { "text": "t" }, "+0": { "text": "t" } } }),
        serde_json::json!({ "choices": [{ "delta": keyed }] }),
        serde_json::json!({ "choices": [{ "delta": [delta.clone()] }] }),
        serde_json::json!({ "choices": [[{ "text": "t", "delta": delta }]] }),
        serde_json::json!({ "choices": [{ "delta": { "reasoning_details": [[{ "text": "t" }]] } }] }),
        serde_json::json!({ "choices": [] }),
        serde_json::json!({ "choices": null }),
        serde_json::json!({ "choices": "x" }),
        serde_json::json!({ "id": "x" }),
        serde_json::json!([{ "choices": [{ "text": "t" }] }]),
        serde_json::json!("frame"),
    ]
    .into()
}

/// The constant-path readers return exactly what `Value::pointer` does.
#[test]
fn constant_path_readers_match_pointer() {
    use super::lanes::{choice_zero, choice_zero_mut, step};
    use super::mirror::{copy_value, Slots, DETAILS_COPY, SUMMARY_COPY, TEXT_COPY};
    let copies = [TEXT_COPY, DETAILS_COPY, SUMMARY_COPY];
    for path in copies {
        assert!(path.starts_with('/') && !path.contains("//") && !path.contains('~'));
    }
    for frame in pointer_shapes() {
        let choice = choice_zero(&frame);
        assert_eq!(choice, frame.pointer("/choices/0"), "{frame}");
        let mut owned = frame.clone();
        assert_eq!(choice_zero_mut(&mut owned).as_deref(), choice, "{frame}");
        let delta = choice.and_then(|choice| choice.get("delta"));
        assert_eq!(delta, frame.pointer("/choices/0/delta"), "{frame}");
        let details = delta.and_then(|delta| delta.get("reasoning_details"));
        assert_eq!(
            details,
            choice.and_then(|c| c.pointer("/delta/reasoning_details"))
        );
        for path in copies
            .into_iter()
            .chain(["/choices/0/delta/content", "/id"])
        {
            assert_eq!(
                copy_value(&frame, path),
                frame.pointer(path),
                "{frame} {path}"
            );
        }
        let slots = Slots::of(&frame);
        for key in ["reasoning", "reasoning_content", "content", "missing"] {
            let pointer = frame
                .pointer(&format!("/choices/0/delta/{key}"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty());
            assert_eq!(slots.delta_text(key), pointer, "{frame} {key}");
        }
    }
    let list = serde_json::json!(["a", "b"]);
    for token in ["0", "1", "2", "00", "01", "+0", "+1", "-1", " 1", "x", ""] {
        assert_eq!(
            step(&list, token),
            list.pointer(&format!("/{token}")),
            "{token}"
        );
    }
    let map = serde_json::json!({ "0": 1, "00": 2, "+0": 3, "": 4 });
    for token in ["0", "00", "+0", "", "1"] {
        assert_eq!(
            step(&map, token),
            map.pointer(&format!("/{token}")),
            "{token}"
        );
    }
}

/// The built-in scanner, counting `sanitize` calls.
struct SanitizeCount {
    inner: crate::firewall::FirewallScanner,
    calls: std::sync::atomic::AtomicUsize,
}

impl crate::firewall::FirewallBackend for SanitizeCount {
    fn config(&self) -> &crate::config::FirewallConfig {
        self.inner.config()
    }
    fn policy(&self) -> &FirewallPolicy {
        self.inner.policy()
    }
    fn outbound_enabled(&self) -> bool {
        self.inner.outbound_enabled()
    }
    fn scan_inbound(&self, text: &str) -> Option<crate::firewall::FirewallMatch> {
        self.inner.scan_inbound(text)
    }
    fn scan_outbound(&self, text: &str) -> Option<crate::firewall::FirewallMatch> {
        self.inner.scan_outbound(text)
    }
    fn scan_locked_guardrails(
        &self,
        text: &str,
        guardrails: &[String],
    ) -> Option<crate::firewall::FirewallMatch> {
        self.inner.scan_locked_guardrails(text, guardrails)
    }
    fn sanitize(&self, text: &str) -> String {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        crate::firewall::FirewallBackend::sanitize(&self.inner, text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        self.inner.redact_outbound(text)
    }
}

/// Texts with no outbound secret take one order, and the result is what both
/// orders give; texts with one still run both.
#[test]
fn sanitize_text_takes_one_order_only_when_the_secrets_pass_is_unchanged() {
    use crate::firewall::FirewallBackend;
    use std::sync::atomic::Ordering;
    let counting = SanitizeCount {
        inner: scanner(),
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    let texts = [
        "",
        "plain answer with nothing in it",
        "Mail john@example.com or call +1 415 555 0100",
        "card 4111 1111 1111 1111 from 10.0.0.1",
        "IBAN GB29 NWBK 6016 1331 9268 19 for john.doe@example.com.",
        "secret=4111 1111 1111 1111 ",
        "password=GB29 NWBK 6016 1331 9268 19 ",
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok",
        "key sk-proj-4111-1111-1111-1111-abcd and secret=4111 1111 1111 1111 for john.doe@example.com.",
        "[REDACTED:email] stays and \u{E000} private use",
    ];
    let (mut shortcut, mut both) = (0, 0);
    for text in texts {
        let redact = |text: &str| counting.redact_outbound(text).0;
        let unchanged = redact(text) == text;
        let secrets_first = redact(&counting.inner.sanitize(&redact(text)));
        let pii_first = redact(&counting.inner.sanitize(text));
        counting.calls.store(0, Ordering::Relaxed);
        let out = super::redact::sanitize_text(&counting, text);
        assert_eq!(out, super::redact::sanitize_text(&counting.inner, text));
        let calls = counting.calls.swap(0, Ordering::Relaxed);
        if unchanged {
            shortcut += 1;
            assert_eq!(calls, 1, "{text}");
            assert_eq!(secrets_first, pii_first, "{text}");
            assert_eq!(out, pii_first, "{text}");
        } else {
            both += 1;
            assert_eq!(calls, 2, "{text}");
        }
    }
    assert!(shortcut >= 5 && both >= 3, "{shortcut} {both}");
}

/// The lane walk as it was before it shared one path buffer: a `format!`
/// per child and `entry().or_default()` per leaf.
fn reference_lanes(
    value: &Value,
    path: &str,
    lanes: &mut std::collections::BTreeMap<String, String>,
) {
    use super::envelope::pointer_token;
    match value {
        Value::Array(values) => {
            for (position, value) in values.iter().enumerate() {
                let lane = match value.get("index") {
                    Some(index) if crate::pipeline::odd_index(value) => {
                        format!("~{}", pointer_token(&index.to_string()))
                    }
                    _ => crate::pipeline::choice_lane(value, position).to_string(),
                };
                assert_eq!(lane, crate::pipeline::lane_segment(value, position));
                reference_lanes(value, &format!("{path}/{lane}"), lanes);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if !(path.is_empty() && matches!(key.as_str(), "id" | "model" | "object")) {
                    reference_lanes(value, &format!("{path}/{}", pointer_token(key)), lanes);
                }
            }
        }
        Value::String(text) => lanes.entry(path.to_owned()).or_default().push_str(text),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[test]
fn the_buffered_lane_walk_keys_every_leaf_as_the_formatted_walk_did() {
    use std::collections::BTreeMap;
    fn choice_envelope(path: &str) -> bool {
        !path.starts_with("/choices/")
            || path.starts_with("/choices/0/") && !path.contains("/delta/")
    }
    fn role_or_finish(path: &str) -> bool {
        path.ends_with("/delta/role") || path.ends_with("/finish_reason")
    }
    fn nothing(_: &str) -> bool {
        false
    }
    let values = [
        serde_json::json!({"id": "x", "model": "m", "object": "o", "created": 1, "choices": [
            {"index": 0, "delta": {"role": "assistant", "content": "a@b"}, "finish_reason": null},
            {"index": 0, "delta": {"content": ".com"}, "finish_reason": "stop"},
            {"index": 2, "delta": {"content": ""}, "logprobs": {"content": [{"token": "t"}]}},
            {"index": -1, "delta": {"content": "neg"}},
            {"index": 0.5, "delta": {"content": "half"}},
            {"index": "a/b~c", "delta": {"content": "odd"}},
            {"index": " 3 ", "delta": {"content": "padded"}},
            {"index": null, "delta": {"content": "null index"}},
            {"delta": {"content": "positional"}}
        ]}),
        serde_json::json!({"a/b": "slash", "a": {"b": "nested", "id": "kept below top"},
            "x~1": "tilde", "": {"": "empty keys"}, "nested": [["deep", ["deeper"]], {"model": "m"}]}),
        serde_json::json!([{"id": "array top"}, "bare", [{"index": 1, "text": "one"}]]),
        serde_json::json!("just text"),
        serde_json::json!(null),
    ];
    for value in &values {
        for start in ["", "/c"] {
            let mut expected = BTreeMap::new();
            reference_lanes(value, start, &mut expected);
            let mut lanes = BTreeMap::new();
            crate::pipeline::collect_sse_payload_lanes(value, start, &mut lanes);
            assert_eq!(lanes, expected, "{value} {start:?}");
            // Lanes already present are continued, not replaced.
            let mut seeded = expected.clone();
            crate::pipeline::collect_sse_payload_lanes(value, start, &mut seeded);
            let mut twice = expected.clone();
            reference_lanes(value, start, &mut twice);
            assert_eq!(seeded, twice, "{value} {start:?}");
            let keeps: [fn(&str) -> bool; 3] = [choice_envelope, role_or_finish, nothing];
            for keep in keeps {
                let mut kept = BTreeMap::new();
                crate::pipeline::collect_sse_payload_lanes_where(value, start, &mut kept, keep);
                let filtered: BTreeMap<String, String> = expected
                    .iter()
                    .filter(|(path, _)| keep(path))
                    .map(|(p, t)| (p.clone(), t.clone()))
                    .collect();
                assert_eq!(kept, filtered, "{value} {start:?}");
            }
        }
    }
}

/// One release of `frame`'s envelope with `memo` swapped in, as `release`
/// does; the strings left memoized.
fn envelope_release(
    scanner: &dyn crate::firewall::FirewallBackend,
    sanitize: bool,
    frame: &Value,
    memo: &mut super::redact::EnvelopeMemo,
) -> (Value, usize) {
    let mut transform = super::redact::Transform::new(scanner, sanitize);
    transform.swap_memo(memo);
    let mut rewritten = frame.clone();
    transform.envelope(&mut rewritten);
    transform.swap_memo(memo);
    // Without the memo: `apply` on every string.
    let mut fresh = frame.clone();
    super::redact::Transform::new(scanner, sanitize).envelope(&mut fresh);
    assert_eq!(rewritten, fresh);
    (rewritten, memo.cached())
}

/// The envelope memo carries over to the next release only for the scanner
/// and Sanitize flag it was computed with.
#[test]
fn the_envelope_memo_is_kept_only_for_its_scanner_and_flag() {
    let (first, other) = (scanner(), scanner());
    let with_model = |model: &str| serde_json::json!({ "model": model, "choices": [{ "delta": { "content": "x" } }] });
    let (a, b) = (with_model("a@example.com"), with_model("b@example.com"));
    let mut memo = super::redact::EnvelopeMemo::default();
    // `model`, its value, `choices`, `delta` and `content`.
    let (out, cached) = envelope_release(&first, false, &a, &mut memo);
    assert_eq!((out["model"].as_str(), cached), (Some("a@example.com"), 5));
    // A Sanitize violation: the memo of the secrets pass alone is dropped.
    let (out, cached) = envelope_release(&first, true, &a, &mut memo);
    assert_ne!(out["model"], "a@example.com");
    assert_eq!(cached, 5);
    // Same scanner and flag: only the new value is added.
    let (out, cached) = envelope_release(&first, true, &b, &mut memo);
    assert_ne!(out["model"], "b@example.com");
    assert_eq!(cached, 6);
    // Another scanner starts over.
    assert_eq!(envelope_release(&other, true, &b, &mut memo).1, 5);
}

/// A stream released frame by frame, with Sanitize turned on part way,
/// redacts as the buffered path does while its envelope memo carries over.
#[test]
fn the_envelope_memo_across_releases_matches_the_buffered_path() {
    let scanner = scanner();
    let mut parts = vec!["Write "; 30];
    parts.extend(["to ", "john", "@example.com ", "now "]);
    parts.extend(vec!["and "; 30]);
    let raw = frames(&parts, None);
    let policy = FirewallPolicy::Sanitize;
    let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
    for seed in 0..4 {
        let (streamed, _) =
            run_streaming(&raw, &splits(&raw, seed, 40), policy.clone(), &scanner).unwrap();
        assert_eq!(visible(&streamed), visible(&buffered), "{seed}");
        assert!(!streamed.contains("john@example.com"), "{seed}");
        let models = streamed
            .matches("\"model\":\"gpt-4o-mini-2024-07-18\"")
            .count();
        assert_eq!(models, parts.len(), "{seed}");
    }
}
