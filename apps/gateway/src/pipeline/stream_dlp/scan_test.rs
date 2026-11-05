use super::*;
use crate::config::FirewallConfig;
use crate::firewall::FirewallScanner;

pub(super) fn scanner() -> FirewallScanner {
    FirewallScanner::new_scoped(FirewallConfig::default())
}

fn content_frame(id: &str, text: &str) -> String {
    let frame = serde_json::json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [{ "index": 0, "delta": { "content": text } }]
    });
    format!("data: {frame}\n\n")
}

fn stream_of(words: &[&str]) -> String {
    let mut raw = String::new();
    for (index, word) in words.iter().enumerate() {
        raw.push_str(&content_frame(&format!("c{index}"), word));
    }
    raw.push_str("data: [DONE]\n\n");
    raw
}

/// Content-only frames for testing token boundaries without envelope fields.
pub(super) fn bare_stream(parts: &[&str]) -> String {
    let mut raw = String::new();
    for part in parts {
        let frame = serde_json::json!({ "choices": [{ "delta": { "content": part } }] });
        raw.push_str(&format!(
            "data: {frame}

"
        ));
    }
    raw.push_str(
        "data: [DONE]

",
    );
    raw
}

/// `fragment` as it would appear inside a JSON string in the output.
fn json_fragment(fragment: &str) -> String {
    let encoded = serde_json::to_string(fragment).unwrap();
    encoded[1..encoded.len() - 1].to_owned()
}

/// Feed `raw` split at the given byte offsets.
pub(super) fn run_streaming(
    raw: &str,
    splits: &[usize],
    policy: FirewallPolicy,
    scanner: &FirewallScanner,
) -> Result<(String, bool), String> {
    let enforce = !matches!(policy, FirewallPolicy::WarnAndContinue);
    let mut dlp = StreamingDlp::new(policy, enforce);
    let bytes = raw.as_bytes();
    let mut out = String::new();
    let mut last = 0;
    let mut offsets: Vec<usize> = splits
        .iter()
        .copied()
        .filter(|s| *s < bytes.len())
        .collect();
    offsets.sort_unstable();
    offsets.push(bytes.len());
    for offset in offsets {
        if offset < last {
            continue;
        }
        let step = dlp.push(&bytes[last..offset], scanner)?;
        out.push_str(&step.bytes);
        last = offset;
        if step.blocked {
            return Ok((out, true));
        }
    }
    let step = dlp.finish(scanner)?;
    out.push_str(&step.bytes);
    Ok((out, step.blocked))
}

/// Deterministic pseudo-random split points.
pub(super) fn splits(raw: &str, seed: u64, count: usize) -> Vec<usize> {
    let mut state = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (0..count)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as usize % raw.len().max(1)
        })
        .collect()
}

const WORDS: &[&str] = &[
    "The ",
    "quick ",
    "brown ",
    "fox ",
    "jumps ",
    "over ",
    "the ",
    "lazy ",
    "dog. ",
    "Streaming ",
    "keeps ",
    "responses ",
    "responsive ",
    "while ",
    "the ",
    "firewall ",
    "still ",
    "reads ",
    "every ",
    "frame.\n",
    "Überprüfung ",
    "läuft ",
    "weiter ",
    "🙂 ",
    "code: ",
    "fn ",
    "main() ",
    "{}\n",
    "tab\tseparated ",
    "line\r\n",
];

pub(super) fn long_clean_stream(seed: u64, frames: usize) -> String {
    let mut state = seed;
    let words: Vec<&str> = (0..frames)
        .map(|_| {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            WORDS[(state >> 33) as usize % WORDS.len()]
        })
        .collect();
    stream_of(&words)
}

#[test]
fn clean_streams_match_the_buffered_rewrite_byte_for_byte() {
    let scanner = scanner();
    for seed in 0..40u64 {
        let raw = long_clean_stream(seed, 300);
        let (buffered, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(violation.is_none());
        for split_seed in 0..5u64 {
            let (streamed, blocked) = run_streaming(
                &raw,
                &splits(&raw, seed * 31 + split_seed, 60),
                FirewallPolicy::Block,
                &scanner,
            )
            .unwrap();
            assert!(!blocked);
            assert_eq!(streamed, buffered, "seed {seed}/{split_seed}");
        }
    }
}

#[test]
fn clean_output_is_released_before_the_stream_ends() {
    let scanner = scanner();
    let raw = long_clean_stream(7, 400);
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let half = raw.len() / 2;
    let early = dlp.push(&raw.as_bytes()[..half], &scanner).unwrap();
    assert!(
        early.bytes.starts_with("data: "),
        "nothing streamed before the end"
    );
}

/// OpenAI-shaped chunk with the boilerplate strings real providers send.
pub(super) fn provider_frame(index: usize, text: &str) -> String {
    let frame = serde_json::json!({
        "id": "chatcmpl-9x7Yq2LmN4pQ",
        "object": "chat.completion.chunk",
        "created": 1_727_000_000 + index,
        "model": "gpt-4o-mini-2024-07-18",
        "system_fingerprint": "fp_0ba0d124f1",
        "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": null }]
    });
    format!(
        "data: {frame}

"
    )
}

#[test]
fn realistic_frames_stream_early_and_still_block_a_secret() {
    let scanner = scanner();
    let words = [
        "Here ", "is ", "a ", "short ", "answer ", "that ", "keeps ", "going. ",
    ];
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let mut first_release = None;
    for index in 0..200 {
        let frame = provider_frame(index, words[index % words.len()]);
        let output = dlp.push(frame.as_bytes(), &scanner).unwrap();
        if first_release.is_none() && !output.bytes.is_empty() {
            first_release = Some(index);
        }
    }
    // Text reaches the client after a handful of frames, not at the end.
    let first_release = first_release.expect("nothing released");
    assert!(
        first_release < 100,
        "first release after {first_release} frames"
    );

    let mut raw = String::new();
    for index in 0..60 {
        raw.push_str(&provider_frame(index, words[index % words.len()]));
    }
    raw.push_str(&provider_frame(
        60,
        "the key is sk-abcdefghijklmnopqrstuvwxyz0123 ok ",
    ));
    for index in 61..120 {
        raw.push_str(&provider_frame(index, words[index % words.len()]));
    }
    raw.push_str(
        "data: [DONE]

",
    );
    for split_seed in 0..6u64 {
        let (streamed, blocked) = run_streaming(
            &raw,
            &splits(&raw, split_seed, 50),
            FirewallPolicy::Block,
            &scanner,
        )
        .unwrap();
        assert!(blocked);
        assert!(!streamed.contains("sk-abcdefghij"));
    }
}

/// (name, fragments of one match). Every fragment is part of the match.
pub(super) fn secret_cases() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        (
            "openai key",
            vec!["sk-abcdefghij", "klmnopqrstuvwxyz", "0123"],
        ),
        (
            "github pat",
            vec!["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"],
        ),
        (
            "email",
            vec!["someone.with.a.long.local.part", "@example", ".com"],
        ),
        ("pem", vec!["-----BEGIN ", "PRIVATE ", "KEY-----"]),
        (
            "db url",
            vec!["postgres://", "admin:hunter2", "@db.internal"],
        ),
        ("ssn", vec!["123-", "45-", "6789"]),
    ]
}

#[test]
fn provider_metadata_does_not_hide_secrets_split_across_content_deltas() {
    let scanner = scanner();
    for (name, fragments) in secret_cases() {
        let mut raw = String::new();
        for index in 0..80 {
            raw.push_str(&provider_frame(index, "clean context before the answer "));
        }
        for (index, fragment) in fragments.iter().enumerate() {
            raw.push_str(&provider_frame(80 + index, fragment));
        }
        raw.push_str(&provider_frame(100, " trailing text "));
        raw.push_str("data: [DONE]\n\n");
        let (streamed, blocked) =
            run_streaming(&raw, &splits(&raw, 17, 80), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{name}: provider metadata hid a split secret");
        let released = streamed.split("Response blocked by policy").next().unwrap();
        for fragment in fragments {
            assert!(
                !released.contains(&format!("\"{}\"", json_fragment(fragment))),
                "{name}: secret fragment escaped"
            );
        }
    }
}

#[test]
fn split_external_tokens_are_redacted_under_warn_and_sanitize() {
    let scanner = scanner();
    let fragments = ["gho_", "abcdefghijklmnopqrstuvwxyz", "0123456789"];
    let mut raw = String::new();
    for (index, fragment) in fragments.iter().enumerate() {
        raw.push_str(&provider_frame(index, fragment));
    }
    raw.push_str(&provider_frame(3, " trailing context "));
    raw.push_str("data: [DONE]\n\n");
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let (streamed, blocked) =
            run_streaming(&raw, &splits(&raw, 13, 20), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(!blocked);
        for fragment in fragments {
            assert!(
                !streamed.contains(fragment),
                "streamed a split token fragment"
            );
            assert!(
                !buffered.contains(fragment),
                "buffered a split token fragment"
            );
        }
        // Text-level redaction replaces the token once and keeps the rest.
        assert!(streamed.contains("[REDACTED:"));
        assert!(streamed.contains("trailing context"));
        assert!(buffered.contains("trailing context"));
    }
}

#[test]
fn interleaved_tool_argument_lanes_cannot_hide_split_tokens() {
    let scanner = scanner();
    let mut raw = String::new();
    for arguments in ["ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789"] {
        let frame = serde_json::json!({ "choices": [{ "index": 0, "delta": {
            "tool_calls": [
                { "index": 0, "function": { "arguments": arguments } },
                { "index": 1, "function": { "arguments": "unrelated text " } }
            ]
        }}] });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    let (streamed, blocked) =
        run_streaming(&raw, &splits(&raw, 13, 20), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!streamed.contains("ghp_"));
    let (streamed, _) = run_streaming(
        &raw,
        &splits(&raw, 13, 20),
        FirewallPolicy::WarnAndContinue,
        &scanner,
    )
    .unwrap();
    assert!(!streamed.contains("ghp_"));
    assert!(streamed.contains("[REDACTED]"));
}

#[test]
fn tool_name_fragments_without_content_are_held_and_redacted() {
    let scanner = scanner();
    let mut raw = String::new();
    for name in ["ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789"] {
        let frame = serde_json::json!({ "choices": [{ "index": 0, "delta": {
            "tool_calls": [{ "index": 0, "type": "function", "function": { "name": name } }]
        }}] });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    let mut dlp = StreamingDlp::new(FirewallPolicy::WarnAndContinue, true);
    assert!(dlp.push(raw.as_bytes(), &scanner).unwrap().bytes.is_empty());
    let finished = dlp.finish(&scanner).unwrap();
    assert!(!finished.bytes.contains("ghp_"));
    assert!(finished.bytes.contains("[REDACTED]"));
    assert!(finished.bytes.contains("\"type\":\"function\""));
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
            .unwrap();
    assert!(!buffered.contains("ghp_"));
}

#[test]
fn no_fragment_of_a_secret_is_released_and_the_stream_is_blocked() {
    let scanner = scanner();
    for (name, fragments) in secret_cases() {
        let mut parts: Vec<&str> = Vec::new();
        for _ in 0..40 {
            parts.extend_from_slice(&["filler ", "words ", "before ", "it "]);
        }
        parts.extend(fragments.iter().copied());
        parts.push(" ");
        for _ in 0..40 {
            parts.extend_from_slice(&["and ", "after "]);
        }
        let raw = bare_stream(&parts);
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(oracle.is_some(), "{name}: oracle must flag it");
        for split_seed in 0..8u64 {
            let (streamed, blocked) = run_streaming(
                &raw,
                &splits(&raw, split_seed, 40),
                FirewallPolicy::Block,
                &scanner,
            )
            .unwrap();
            assert!(blocked, "{name}/{split_seed}: not blocked");
            let released = streamed.split("Response blocked by policy").next().unwrap();
            for fragment in &fragments {
                assert!(
                    !released.contains(&format!("\"{}\"", json_fragment(fragment))),
                    "{name}/{split_seed}: fragment {fragment:?} released"
                );
            }
        }
    }
}

#[test]
fn keyword_padding_cannot_push_the_keyword_out_of_view() {
    let scanner = scanner();
    let padding = " ".repeat(3000);
    let cases: Vec<Vec<String>> = vec![
        vec![
            "Authorization: Bearer".into(),
            padding.clone(),
            "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH".into(),
        ],
        vec![
            "api_key".into(),
            padding.clone(),
            "=".into(),
            padding.clone(),
            "abcdefghijklmnopqrstuvwxyz0123".into(),
        ],
        vec![
            "passport".into(),
            padding.clone(),
            "no.".into(),
            padding.clone(),
            "AB1234567".into(),
        ],
    ];
    for parts in cases {
        let secret = parts.last().unwrap().clone();
        let mut words: Vec<String> = vec!["intro ".into(); 50];
        words.extend(parts);
        words.push(" trailing".into());
        let refs: Vec<&str> = words.iter().map(String::as_str).collect();
        let raw = bare_stream(&refs);
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(oracle.is_some());
        for split_seed in 0..6u64 {
            let (streamed, blocked) = run_streaming(
                &raw,
                &splits(&raw, split_seed, 80),
                FirewallPolicy::Block,
                &scanner,
            )
            .unwrap();
            assert!(blocked, "padded secret not blocked");
            assert!(!streamed.contains(&secret));
        }
    }
}

#[test]
fn obfuscated_secrets_are_still_caught() {
    let scanner = scanner();
    // Zero-width split and fullwidth letters are normalized before matching.
    let zero_width = "sk-abcdefghij\u{200B}klmnopqrstuvwxyz";
    let fullwidth = "ｓｋ-abcdefghijklmnopqrstuvwxyz0123";
    for secret in [zero_width, fullwidth] {
        let mut words = vec!["lead "; 60];
        words.push(secret);
        words.push(" tail");
        let raw = bare_stream(&words);
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        let (streamed, blocked) =
            run_streaming(&raw, &splits(&raw, 11, 30), FirewallPolicy::Block, &scanner).unwrap();
        assert!(oracle.is_some());
        assert!(blocked);
        assert!(!streamed.contains(&json_fragment(secret)));
    }
}

#[test]
fn tool_call_arguments_are_redacted_per_frame() {
    let scanner = scanner();
    let secret = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
    let frame = serde_json::json!({
        "choices": [{ "delta": { "tool_calls": [{ "function": { "arguments": secret } }] } }]
    });
    let raw = format!("data: {frame}\n\ndata: [DONE]\n\n");
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
            .unwrap();
    let (streamed, _) = run_streaming(
        &raw,
        &[5, 17, 40],
        FirewallPolicy::WarnAndContinue,
        &scanner,
    )
    .unwrap();
    assert_eq!(streamed, buffered);
    assert!(!streamed.contains(secret));
}

#[test]
fn sanitize_redacts_the_violation_and_keeps_streaming() {
    let scanner = scanner();
    let mut words = vec!["lead "; 80];
    words.push("reach me at someone@example.com please ");
    words.extend(vec!["tail "; 80]);
    let raw = stream_of(&words);
    let (streamed, blocked) = run_streaming(
        &raw,
        &splits(&raw, 5, 50),
        FirewallPolicy::Sanitize,
        &scanner,
    )
    .unwrap();
    assert!(!blocked);
    assert!(!streamed.contains("someone@example.com"));
    assert!(streamed.ends_with("data: [DONE]\n\n"));
}

#[test]
fn malformed_frames_and_crlf_follow_the_buffered_rules() {
    let scanner = scanner();
    let crlf = content_frame("a", "hello ").replace("\n\n", "\r\n\r\n") + "data: [DONE]\r\n\r\n";
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&crlf, &scanner, &FirewallPolicy::Block).unwrap();
    let (streamed, _) = run_streaming(&crlf, &[3, 9, 30], FirewallPolicy::Block, &scanner).unwrap();
    assert_eq!(streamed, buffered);

    assert!(run_streaming(
        "data: {not-json}\n\n",
        &[4],
        FirewallPolicy::Block,
        &scanner
    )
    .is_err());
    assert!(run_streaming("event: ping\n\n", &[], FirewallPolicy::Block, &scanner).is_err());
}
