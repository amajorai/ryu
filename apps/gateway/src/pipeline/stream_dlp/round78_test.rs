//! Round 78: output evaluators judge each choice of an n>1 stream on its own
//! (not choices interleaved in wire order) plus the strings a client gets
//! outside the rendered text, and only output evaluators or outbound custom
//! patterns turn off incremental streaming.

use serde_json::{json, Value};

use super::reach::IGNORABLE_REACH;
use super::scan_test::scanner;
use super::StreamingDlp;
use crate::config::{CustomPattern, CustomPatternKind, FirewallConfig, FirewallPolicy};
use crate::evaluators::{EvaluatorBinding, EvaluatorRegistry};
use crate::firewall::FirewallScanner;

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn content(index: u64, text: &str) -> Value {
    json!({ "choices": [{ "index": index, "delta": { "content": text } }] })
}

#[test]
fn interleaved_choices_are_judged_one_after_another() {
    let scanner = scanner();
    let raw = sse(&[
        content(0, "Call 555-123-"),
        content(1, "Hi "),
        content(0, "4567"),
    ]);
    let (_, assembled, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
            .unwrap();
    assert_eq!(assembled, "Call 555-123-4567\nHi ");
    assert!(scanner.scan_outbound(&assembled).is_some());
}

#[test]
fn tool_call_names_are_judged_but_not_replayed() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "role": "assistant",
            "tool_calls": [{ "index": 0, "id": "call_1", "type": "function",
                "function": { "name": "lookup_user", "arguments": "{\"q\":" } }] } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0,
            "function": { "arguments": "\"x\"}" } }] }, "finish_reason": "tool_calls" }] }),
    ]);
    let (_, assembled, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
            .unwrap();
    for expected in ["lookup_user", "call_1"] {
        assert!(assembled.contains(expected), "{}", assembled);
    }
    assert!(assembled.starts_with("{\"q\":\"x\"}\n"));
}

fn binding(id: &str) -> EvaluatorBinding {
    EvaluatorBinding {
        id: id.into(),
        enabled: true,
        inline_action: Some(FirewallPolicy::Block),
        offline: None,
        locked: false,
    }
}

fn config(evaluators: Vec<EvaluatorBinding>, kinds: &[CustomPatternKind]) -> FirewallScanner {
    FirewallScanner::new(FirewallConfig {
        evaluators,
        custom_patterns: kinds
            .iter()
            .map(|kind| CustomPattern {
                name: "custom".into(),
                regex: "ignore all previous instructions".into(),
                kind: *kind,
            })
            .collect(),
        ..FirewallConfig::default()
    })
}

#[test]
fn only_output_evaluators_buffer_the_stream() {
    let registry = EvaluatorRegistry::new();
    let bound = |scanner: &FirewallScanner| super::super::output_inline_bound(scanner, &registry);
    assert!(!bound(&config(vec![binding("prompt_injection")], &[])));
    assert!(!bound(&config(vec![binding("no_such_evaluator")], &[])));
    assert!(bound(&config(vec![binding("pii_leakage")], &[])));
    let mut warn = binding("toxicity");
    warn.inline_action = Some(FirewallPolicy::WarnAndContinue);
    assert!(bound(&config(vec![warn], &[])));
}

#[test]
fn only_outbound_custom_patterns_buffer_the_stream() {
    let outbound = |scanner: &FirewallScanner| super::super::outbound_custom_patterns(scanner);
    assert!(!outbound(&config(
        Vec::new(),
        &[
            CustomPatternKind::PromptInjection,
            CustomPatternKind::CodeInjection,
            CustomPatternKind::Toxicity,
            CustomPatternKind::Bias,
        ],
    )));
    assert!(outbound(&config(Vec::new(), &[CustomPatternKind::Pii])));
    assert!(outbound(&config(Vec::new(), &[CustomPatternKind::Secret])));
}

/// The release-cut helpers as they were before their byte fast paths.
mod before {
    use super::super::reach::{is_script_boundary, IGNORABLE_REACH, KEYWORDS, PADDING_REACH};
    use super::super::{StreamingDlp, BOUNDED_MATCH_LEN};
    use ryu_gw_firewall::{fold_for_redaction, normalize_for_scan};

    pub(super) fn opens(token: &str) -> bool {
        if token.chars().any(char::is_numeric) || token.contains("-----") {
            return true;
        }
        let lower = fold_case(token);
        KEYWORDS.iter().any(|keyword| lower.contains(keyword))
    }

    pub(super) fn fold_case(token: &str) -> String {
        let fold = |other: char| match other {
            '\u{17F}' => 's',
            '\u{212A}' => 'k',
            other => {
                let mut lower = other.to_lowercase();
                match (lower.next(), lower.next()) {
                    (Some(single), None) => single,
                    _ => other,
                }
            }
        };
        token.chars().map(fold).collect()
    }

    pub(super) fn back(dlp: &StreamingDlp, position: usize, count: usize) -> (usize, bool) {
        let end = position.saturating_sub(dlp.base).min(dlp.text.len());
        let mut remaining = count;
        for (index, character) in dlp.text[..end].char_indices().rev() {
            let after = dlp.base + index + character.len_utf8();
            if remaining == 0 || end - index > count + IGNORABLE_REACH {
                return (after, remaining != 0);
            }
            // Scan-view bytes, as main's `bounded_cut` counts them: a TAG
            // character none, any other its fold (zero-width ones fold away).
            let mut buffer = [0u8; 4];
            let width = if ('\u{E0000}'..='\u{E007F}').contains(&character) {
                0
            } else {
                fold_for_redaction(character.encode_utf8(&mut buffer)).len()
            };
            remaining = remaining.saturating_sub(width);
        }
        (dlp.base, false)
    }

    pub(super) fn cut(dlp: &StreamingDlp, safe_end: usize) -> (usize, bool) {
        let cut = if dlp.run.open_form && dlp.run.form_start < safe_end {
            dlp.run.form_start.max(dlp.base)
        } else {
            safe_end
        };
        let (window, capped) = back(dlp, cut, BOUNDED_MATCH_LEN);
        if capped {
            return (dlp.released_end.max(dlp.base).min(cut), true);
        }
        let end = cut - dlp.base;
        let window = (window.max(dlp.base) - dlp.base).min(end);
        let boundary = |c: char| c.is_ascii_whitespace() || is_script_boundary(c);
        let mut index = dlp.token_start(window, window.saturating_sub(PADDING_REACH));
        while let Some(character) = dlp.text[index..end].chars().next() {
            if boundary(character) {
                index += character.len_utf8();
                continue;
            }
            let start = index;
            let rest = &dlp.text[index..end];
            index += rest.find(boundary).unwrap_or(rest.len());
            if opens(&normalize_for_scan(&dlp.text[start..index])) {
                return ((dlp.base + start.max(window)).min(cut), false);
            }
        }
        (cut, false)
    }
}

/// Tokens split on `|`, the empty one first.
const TOKENS: &str = "|word|42|----|-----|x-----y|AWS|aws|bear|BeArEr|x_API_KEY=|apiKey|Api-Key\
    |PassPort|ＢＥＡＲＥＲ|ſecret|٠١٢|İstanbul|ΣΊΣΥΦΟΣ|\u{212A}EY|東京|a\u{200B}ws";

#[test]
fn ascii_fast_paths_judge_and_fold_as_before() {
    for token in TOKENS.split('|') {
        let opens = super::reach::opens_bounded_match(token);
        assert_eq!(opens, before::opens(token), "{token}");
        assert_eq!(super::reach::fold_case(token), before::fold_case(token));
        let mut folded = String::from("ab");
        super::reach::fold_case_into(token, &mut folded);
        assert_eq!(folded, format!("ab{}", before::fold_case(token)), "{token}");
    }
}

/// Every cut and look-back the stream could ask for agrees with the old walks.
fn assert_parity(dlp: &StreamingDlp) {
    for index in (0..=dlp.text.len()).filter(|index| dlp.text.is_char_boundary(*index)) {
        let position = dlp.base + index;
        let cut = dlp.release_cut_checked(position);
        assert_eq!(cut, before::cut(dlp, position), "{index}");
        for count in [0, 1, 2, 3, 7, super::BOUNDED_MATCH_LEN] {
            let back = dlp.back_visible_capped(position, count);
            assert_eq!(back, before::back(dlp, position, count), "{index} {count}");
        }
    }
}

/// One line per push (frames split on `|`, `@` standing for `filler`): the
/// content released, the held form's start and the run tail.
fn pushes(frames: &str, filler: &str) -> String {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Sanitize, true);
    let mut steps = Vec::new();
    for (index, frame) in frames.replace('@', filler).split('|').enumerate() {
        let line = super::scan_test::provider_frame(index, frame);
        let out = dlp.push(line.as_bytes(), &scanner).unwrap().bytes;
        assert_parity(&dlp);
        steps.push(format!(
            "{}|{}|{}",
            released(&out),
            dlp.run.form_start,
            dlp.run.tail
        ));
    }
    let out = dlp.finish(&scanner).unwrap().bytes;
    steps.push(format!(
        "{}|{}|{}",
        released(&out),
        dlp.run.form_start,
        dlp.run.tail
    ));
    steps.join("\n")
}

fn released(sse: &str) -> String {
    let data = sse.lines().filter_map(|line| line.strip_prefix("data: "));
    let frames = data.filter_map(|data| serde_json::from_str::<Value>(data).ok());
    let content = |frame: Value| {
        frame["choices"][0]["delta"]["content"]
            .as_str()
            .map(str::to_owned)
    };
    frames.filter_map(content).collect()
}

/// The run tail is kept in the scan view's fold, which folds an ideographic
/// full stop to `.`; the released text keeps it as written.
#[test]
fn release_cuts_hold_and_release_as_before() {
    let filler = "plain prose without any opener in it at all ".repeat(5);
    let frames = "Hello there, |@|東京|の会議は|明日です。|token ＢＥＡＲＥＲ |abc|\u{200B}def \
        |٠١٢ |x-----y done |@|call 415-|555-0134 |bye ";
    let expected = "|0|
Hello there, @|0|
東京|0|東京
の会議は|0|東京の会議は
明日です。|0|東京の会議は明日です.
|0|
|0|abc
|0|
|0|
|0|
token ＢＥＡＲＥＲ abc\u{200B}def ٠١٢ x-----y done @|0|
|0|415-
|0|
|0|
call [REDACTED:PHONE_US] bye |0|";
    assert_eq!(pushes(frames, &filler), expected.replace('@', &filler));
}

#[test]
fn split_unbounded_forms_hold_from_the_same_token() {
    let frames = "note: pass|word=x|y |more 東京Pass|WORD=x| 雨 |ſecret|=zz| ok \u{212A}ey \
        |Ｐassword=|y |pass|word=hunter2| end ";
    let expected = "|0|pass
|6|password=x
note: password=xy |6|
|6|東京pass
|23|東京password=x
more 東京PassWORD=x 雨 |23|
|23|secret
|44|secret=zz
ſecret=zz ok \u{212A}ey |44|
|64|password=
Ｐassword=y |64|
|64|pass
|77|password=hunter2
|77|
[REDACTED:secret_param] end |77|";
    assert_eq!(pushes(frames, ""), expected);
}

#[test]
fn look_backs_over_stripped_runs_match_the_old_walk() {
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let zero_width = "\u{200B}".repeat(IGNORABLE_REACH / 3 + 8);
    for text in ["ab\u{200B}\u{200B}cd東京", "東京x", "abc", ""] {
        dlp.text = text.repeat(40);
        assert_parity(&dlp);
    }
    dlp.text = format!("a{zero_width}bcd");
    dlp.base = 7;
    let end = dlp.base + dlp.text.len();
    for position in [end, end - 1, end - 3, 8, 7, 0] {
        for count in [0, 2, 3, 4, super::BOUNDED_MATCH_LEN] {
            let back = dlp.back_visible_capped(position, count);
            assert_eq!(
                back,
                before::back(&dlp, position, count),
                "{position} {count}"
            );
        }
        assert_eq!(
            dlp.release_cut_checked(position.max(7)),
            before::cut(&dlp, position.max(7))
        );
    }
}

#[test]
fn fixed_leaf_check_agrees_with_the_fixed_lanes() {
    let filters = json!({ "hate": { "filtered": false, "severity": "safe" } });
    let frames = [
        content(0, "hello"),
        json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": null }] }),
        json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }),
        json!({ "choices": [{ "index": 0, "delta": { "role": "assistant" } }] }),
        json!({ "choices": [{ "index": 0, "delta": {
            "reasoning_details": [{ "type": "reasoning.text", "text": "x" }] } }] }),
        json!({ "choices": [{ "index": 0, "content_filter_results": filters }] }),
        json!({ "choices": [{ "index": 0, "delta": { "a/role": "assistant" } }] }),
    ];
    let expected = [false, false, true, true, true, true, false];
    for (frame, expected) in frames.iter().zip(expected) {
        let mut lanes = std::collections::BTreeMap::new();
        super::super::collect_sse_payload_lanes_where(
            frame,
            "",
            &mut lanes,
            super::fixed::fixed_path,
        );
        assert_eq!(super::fixed::has_fixed_leaf(frame), expected, "{frame}");
        assert_eq!(!lanes.is_empty(), expected, "{frame}");
    }
    // A key alone (not its path) decides, so the check may only over-report.
    let loose = json!({ "type": "x", "choices": [{ "index": 1, "delta": { "role": "user" } }] });
    assert!(super::fixed::has_fixed_leaf(&loose));
}

#[test]
fn pruned_envelope_walk_collects_the_full_walks_lanes() {
    let reasoning = json!({ "reasoning_details": [
        { "type": "reasoning.encrypted", "id": "r1", "format": "f", "data": "d" }] });
    let filters = json!({ "custom_blocklists": [{ "id": "b1", "filtered": true }],
        "protected_material_text": { "citation": { "URL": "u" } } });
    let frames = [
        content(0, "hello"),
        content(1, "hello"),
        json!({ "id": "x", "model": "m", "system_fingerprint": "fp",
            "choices": [{ "index": -1, "stop_reason": "a" }, { "index": "a", "stop_reason": "b" }] }),
        json!({ "choices": [{ "index": "0", "delta": reasoning }] }),
        json!({ "choices": [{ "index": 0, "content_filter_results": filters.clone() }] }),
        json!({ "choices": [{ "content_filter_offsets": filters }, { "stop_reason": "s" }] }),
        json!({ "choices": [{ "index": 0, "stop_reason": "end", "matched_stop": "m" }] }),
        json!({ "choices": { "0": { "stop_reason": "end" }, "1": { "x": "y" } } }),
        json!({ "choices": ["scalar", 0, [{ "stop_reason": "s" }]], "model": "m" }),
        json!({ "nested": { "choices": [{ "index": 1, "stop_reason": "s" }] } }),
        json!(["top", { "stop_reason": "s" }]),
        json!("scalar frame"),
    ];
    for frame in &frames {
        let (mut pruned, mut full) = Default::default();
        super::super::collect_envelope_lanes(frame, &mut pruned);
        let keep = super::super::envelope_lane;
        super::super::collect_sse_payload_lanes_where(frame, "", &mut full, keep);
        assert_eq!(pruned, full, "{frame}");
    }
}

/// Splitting with the token-mirror flag the caller computed is splitting
/// without it, and a split frame's halves carry no mirrors (`HeldFrame`).
#[test]
fn split_boundary_with_a_given_mirror_flag_matches_split_boundary() {
    let split = |delta: Value, extra: Value| {
        let mut choice = json!({ "index": 0, "delta": delta });
        for (key, value) in extra.as_object().into_iter().flatten() {
            choice[key] = value.clone();
        }
        json!({ "id": "c", "model": "m", "choices": [choice] })
    };
    let both = json!({ "reasoning_content": "think", "content": "answer" });
    let frames = [
        split(both.clone(), json!({})),
        split(both.clone(), json!({ "logprobs": { "content": [] } })),
        split(
            json!({ "reasoning": "r", "content": "a", "token_ids": [1] }),
            json!({}),
        ),
        split(both.clone(), json!({ "text": "answer" })),
        split(
            json!({ "reasoning_content": "think", "content": "" }),
            json!({}),
        ),
        json!({ "choices": [{ "index": 0, "delta": both.clone() },
            { "index": 1, "delta": both }] }),
    ];
    for frame in &frames {
        let mirrors = super::super::has_token_mirrors(frame);
        let given = super::super::split_boundary_with(frame, Some(mirrors));
        assert_eq!(given, super::super::split_boundary(frame), "{frame}");
        for half in given.iter().flatten() {
            assert!(!super::super::has_token_mirrors(half), "{half}");
        }
    }
    assert!(super::super::split_boundary(&frames[0]).is_some());
}

/// The projection into a reused, cleared buffer is the fresh projection.
#[test]
fn projection_into_a_cleared_buffer_matches_a_fresh_one() {
    let values = [
        json!({ "": "empty key", "choices": [{ "delta": { "content": "hi" } }] }),
        json!({ "": { "": "" }, "k": ["a", { "": "b" }] }),
        json!(["x", 1, null, { "y": "z" }]),
        json!("scalar"),
        json!({}),
    ];
    let mut buffer = String::new();
    for value in &values {
        buffer.push_str("dirty");
        buffer.clear();
        super::super::json_string_projection_into(value, &mut buffer);
        assert_eq!(
            buffer,
            super::super::json_string_projection(value),
            "{value}"
        );
    }
}
