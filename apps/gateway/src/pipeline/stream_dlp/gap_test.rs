//! Release lag, provider envelope lanes and fallback precision.

use serde_json::{json, Value};

use super::scan_test::{provider_frame, run_streaming, scanner, splits};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn content(sse: &str) -> String {
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

fn with_done(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

/// A digit- and keyword-free filler word, so only a case's own tokens can
/// hold the release.
fn word(prefix: &str, index: usize) -> String {
    let letter = char::from(b'a' + u8::try_from(index % 26).unwrap_or(0));
    format!("{prefix}{letter} ")
}

/// Prose without digits or keywords is released as soon as each word is
/// complete, not 192 bytes behind.
#[test]
fn prose_streams_word_by_word() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let mut sent = String::new();
    for (index, word) in ["Hello ", "there, ", "how ", "are "].iter().enumerate() {
        sent.push_str(
            &dlp.push(provider_frame(index, word).as_bytes(), &scanner)
                .unwrap()
                .bytes,
        );
    }
    assert_eq!(content(&sent), "Hello there, how are ");
}

/// Tokens that can open a whitespace-spanning match still hold the release
/// until the match is complete, under every policy.
#[test]
fn bounded_matches_never_release_a_fragment_early() {
    let scanner = scanner();
    let cases: [(&str, &[&str]); 9] = [
        ("phone", &["call ", "415-", "555-", "0134 ", "now "]),
        (
            "card",
            &["card ", "4111 ", "1111 ", "1111 ", "1111 ", "ok "],
        ),
        (
            "iban",
            &[
                "iban ", "GB29 ", "NWBK ", "6016 ", "1331 ", "9268 ", "19 ", "ok ",
            ],
        ),
        ("pem", &["-----BEGIN ", "PRIVATE ", "KEY----- ", "data "]),
        (
            "arabic phone",
            &[
                "call ",
                "\u{662}\u{661}\u{662} ",
                "\u{665}\u{665}\u{665} ",
                "\u{660}\u{661}\u{669}\u{668} ",
                "now ",
            ],
        ),
        (
            "arabic ssn",
            &[
                "ssn ",
                "\u{661}\u{662}\u{663} ",
                "\u{664}\u{665} ",
                "\u{666}\u{667}\u{668}\u{669} ",
                "ok ",
            ],
        ),
        (
            "long s aws",
            &[
                "aw\u{17F} ",
                "key ",
                "secret ",
                "= ",
                "\"wJalrXUtnFEMIKMDENGbPxRfiCYEXAMPLEKEYabc\" ",
                "x ",
            ],
        ),
        (
            "bearer",
            &[
                "Authorization: ",
                "Bearer ",
                "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH ",
                "x ",
            ],
        ),
        (
            "aws",
            &[
                "aws ",
                "key ",
                "secret ",
                "\"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\" ",
                "x ",
            ],
        ),
    ];
    for (name, parts) in cases {
        let mut frames: Vec<Value> = (0..30)
            .map(|index| json!({ "choices": [{ "index": 0, "delta": { "content": word("lead", index) } }] }))
            .collect();
        frames.extend(
            parts
                .iter()
                .map(|part| json!({ "choices": [{ "index": 0, "delta": { "content": part } }] })),
        );
        frames.extend((0..30).map(|index| json!({ "choices": [{ "index": 0, "delta": { "content": word("tail", index) } }] })));
        let raw = with_done(&frames);
        let (_, _, oracle) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(
            oracle.is_some(),
            "{name}: the non-stream oracle must flag it"
        );
        let offsets: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
        let (streamed, blocked) =
            run_streaming(&raw, &offsets, FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{name}: not blocked");
        let released = content(streamed.split("Response blocked by policy").next().unwrap());
        for part in parts.iter().skip(1) {
            let trimmed = part.trim();
            if trimmed.len() > 3 {
                assert!(
                    !released.contains(trimmed),
                    "{name}: {trimmed:?} released before block"
                );
            }
        }
    }
}

/// A value split across frames' provider envelope fields is detected and the
/// field is masked while the value is in view; varying padding is untouched.
#[test]
fn envelope_fields_cannot_carry_a_split_value() {
    let scanner = scanner();
    let mut frames = Vec::new();
    for (index, piece) in ["sk-abcdefghij", "klmnopqrstuvwxyz", "0123456789"]
        .iter()
        .enumerate()
    {
        frames.push(json!({ "system_fingerprint": piece, "choices": [{ "index": 0, "delta": { "content": format!("word{index} ") } }] }));
    }
    frames.push(
        json!({ "obfuscation": "Zq", "choices": [{ "index": 0, "delta": { "content": "end " } }] }),
    );
    let raw = with_done(&frames);
    let (streamed, blocked) =
        run_streaming(&raw, &splits(&raw, 5, 10), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "split envelope value not detected");
    assert!(!streamed.contains("klmnopqrstuvwxyz"));
    let (streamed, _) =
        run_streaming(&raw, &[], FirewallPolicy::WarnAndContinue, &scanner).unwrap();
    assert!(!streamed.contains("klmnopqrstuvwxyz") && !streamed.contains("0123456789"));
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
            .unwrap();
    assert!(!buffered.contains("sk-abcdefghij") && !buffered.contains("klmnopqrstuvwxyz"));

    // OpenAI-style random padding is replaced with same-length filler and
    // does not hold the stream.
    let padded: Vec<Value> = ["aZ3", "Qw", "x9Lm", "P"]
        .iter()
        .enumerate()
        .map(|(index, pad)| json!({ "obfuscation": pad, "choices": [{ "index": 0, "delta": { "content": word("w", index) } }] }))
        .collect();
    let raw = with_done(&padded);
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let early = dlp.push(raw.as_bytes(), &scanner).unwrap();
    assert!(!early.bytes.is_empty(), "padding held the stream");
    let streamed = format!("{}{}", early.bytes, dlp.finish(&scanner).unwrap().bytes);
    assert!(streamed.contains("\"obfuscation\":\"xxxx\""), "{streamed}");
    assert!(!streamed.contains("x9Lm") && !streamed.contains("[REDACTED]"));
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert_eq!(buffered, streamed);
}

/// A tool call after content whose secret was already redacted at text level
/// is not masked just because the raw secret is still within reach.
#[test]
fn tool_calls_after_a_redacted_value_are_not_masked() {
    let scanner = scanner();
    let mut frames: Vec<Value> = [
        "Use ",
        "key ",
        "sk-abcdefghij",
        "klmnopqrstuvwxyz0123",
        " now. ",
    ]
    .iter()
    .map(|part| json!({ "choices": [{ "index": 0, "delta": { "content": part } }] }))
    .collect();
    frames.push(json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0, "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } }] } }] }));
    let raw = with_done(&frames);
    let (streamed, _) =
        run_streaming(&raw, &[], FirewallPolicy::WarnAndContinue, &scanner).unwrap();
    assert!(!streamed.contains("sk-abcdefghij"));
    assert!(streamed.contains("get_weather"), "{streamed}");
    assert!(streamed.contains("Paris"));
}

/// The leading content of a held-whole stream is not released on its own when
/// a value continues from it into content after a tool call.
#[test]
fn head_release_waits_for_a_value_continuing_past_a_tool_call() {
    let scanner = scanner();
    let frames = [
        json!({ "choices": [{ "index": 0, "delta": { "content": "Use sk-abc" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"city\":\"Paris\"}" } }] } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "defghijklmnopqrstuvwxyz" } }] }),
    ];
    let raw = with_done(&frames);
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (streamed, _) = run_streaming(&raw, &[], policy, &scanner).unwrap();
        assert!(!streamed.contains("sk-abc"), "{streamed}");
    }
}

/// A keyword followed by more padding than the scan reach still keeps its
/// value from being released.
#[test]
fn keywords_beyond_the_padding_reach_are_carried() {
    let scanner = scanner();
    let mut passport = vec!["My passport".to_owned()];
    passport.extend(std::iter::repeat_n(" #".to_owned(), 3000));
    passport.extend([" AB1234567".to_owned(), " end.".to_owned()]);
    let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    let mut bearer = vec!["Authorization: Bearer".to_owned()];
    bearer.extend(std::iter::repeat_n(" \u{3000}".to_owned(), 3000));
    bearer.extend([format!(" {token}"), " end.".to_owned()]);
    for (value, parts) in [("AB1234567", passport), (token, bearer)] {
        let frames: Vec<Value> = parts
            .iter()
            .map(|part| json!({ "choices": [{ "index": 0, "delta": { "content": part } }] }))
            .collect();
        let raw = with_done(&frames);
        let offsets: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
        for policy in [
            FirewallPolicy::Block,
            FirewallPolicy::Sanitize,
            FirewallPolicy::WarnAndContinue,
        ] {
            let (streamed, _) = run_streaming(&raw, &offsets, policy.clone(), &scanner).unwrap();
            if matches!(policy, FirewallPolicy::WarnAndContinue) && value == "AB1234567" {
                continue; // PII is only redacted under Sanitize.
            }
            assert!(
                !content(&streamed).contains(value),
                "{value} released under {policy:?}"
            );
        }
    }
}

/// `push` as it split lines before handing them straight from the chunk.
fn push_buffering_every_line(
    dlp: &mut StreamingDlp,
    chunk: &[u8],
    scanner: &crate::firewall::FirewallScanner,
) -> Result<super::DlpOutput, String> {
    if dlp.finished {
        return Ok(super::DlpOutput::default());
    }
    let mut start = 0;
    for (index, byte) in chunk.iter().enumerate() {
        if *byte == b'\n' {
            dlp.line.extend_from_slice(&chunk[start..index]);
            let line = std::mem::take(&mut dlp.line);
            dlp.take_line(&line, scanner)?;
            start = index + 1;
        }
    }
    dlp.line.extend_from_slice(&chunk[start..]);
    if dlp.held_wire_bytes.max(dlp.text.len()) + dlp.refusal_bytes + dlp.line.len()
        > super::MAX_HELD_BYTES
    {
        return Err(super::OVERSIZED.to_owned());
    }
    let mut output = dlp.advance(false, scanner);
    if std::mem::take(&mut dlp.keep_alive) && output.bytes.is_empty() && !output.blocked {
        output.bytes.push_str(": keep-alive\n\n");
    }
    Ok(output)
}

/// Lines handed straight from the chunk give every push the output the
/// buffered lines gave, however the stream is cut.
#[test]
fn lines_taken_from_the_chunk_stream_as_buffered_ones() {
    let scanner = scanner();
    let frame = |text: &str| {
        json!({ "choices": [{ "index": 0, "delta": { "content": text } }] }).to_string()
    };
    let mut clean = format!("data: {}\r\n\r\n: ping\n\n", frame("héllo 世界 "));
    clean.push_str(&format!(
        "data: {}\n\ndata: {}\n\n",
        frame("plain "),
        frame("end.")
    ));
    let mut invalid = clean.clone().into_bytes();
    invalid.extend_from_slice(
        b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" a\xff\"}}]}\n\n",
    );
    let secret = format!(
        "{clean}data: {}\n\n",
        frame("key sk-abcdefghijklmnopqrstuvwxyz012345 ")
    );
    let streams = [clean.clone().into_bytes(), invalid, secret.into_bytes()];
    let mut clean_contents = Vec::new();
    for (stream_index, raw) in streams.iter().enumerate() {
        let multibyte = raw.windows(2).position(|pair| pair[0] >= 0xC0).unwrap_or(0) + 1;
        let after_cr = raw.iter().position(|byte| *byte == b'\r').unwrap_or(0) + 1;
        let mut cuts: Vec<Vec<usize>> = vec![
            vec![],
            (1..raw.len()).collect(),
            vec![10],
            vec![after_cr],
            vec![multibyte],
            vec![after_cr, after_cr + 1, multibyte],
        ];
        let text = String::from_utf8_lossy(raw).into_owned();
        cuts.extend((0..4).map(|seed| splits(&text, seed, 6)));
        for policy in [
            FirewallPolicy::Block,
            FirewallPolicy::Sanitize,
            FirewallPolicy::WarnAndContinue,
        ] {
            for cut in &cuts {
                let mut offsets = cut.clone();
                offsets.retain(|offset| *offset < raw.len());
                offsets.sort_unstable();
                offsets.dedup();
                offsets.push(raw.len());
                let enforce = !matches!(policy, FirewallPolicy::WarnAndContinue);
                let mut fast = StreamingDlp::new(policy.clone(), enforce);
                let mut head = StreamingDlp::new(policy.clone(), enforce);
                let (mut last, mut sent) = (0, String::new());
                for offset in offsets {
                    let chunk = &raw[last..offset];
                    let got = fast.push(chunk, &scanner);
                    let want = push_buffering_every_line(&mut head, chunk, &scanner);
                    let view = |out: Result<super::DlpOutput, String>| {
                        out.map(|out| (out.bytes, out.blocked, format!("{:?}", out.violation)))
                    };
                    let (got, want) = (view(got), view(want));
                    assert_eq!(got, want, "stream {stream_index} cut {cut:?} {policy:?}");
                    assert_eq!(fast.line, head.line);
                    sent.push_str(&got.map(|out| out.0).unwrap_or_default());
                    last = offset;
                }
                let finished = fast.finish(&scanner).map(|out| out.bytes);
                assert_eq!(finished, head.finish(&scanner).map(|out| out.bytes));
                sent.push_str(&finished.unwrap_or_default());
                if stream_index == 0 {
                    clean_contents.push(content(&sent));
                }
            }
        }
    }
    assert!(clean_contents
        .iter()
        .all(|text| text == "héllo 世界 plain end."));
}

/// A frame ending inside a complete replaced value waits, and the pushes
/// that only split the next SSE line release nothing again: each push gives
/// the output it gave before such a release was skipped.
#[test]
fn a_frame_waiting_inside_a_value_survives_split_lines() {
    let scanner = scanner();
    let frame = |text: &str| {
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": text } }] });
        format!("data: {frame}\n\n")
    };
    let raw: String = [
        "mail john.doe@exa",
        "mple.com then mo",
        "re words ",
        "again ",
    ]
    .into_iter()
    .map(frame)
    .collect();
    let head = ["mail [REDACTED:EMAIL] then mo", "", "re words "];
    // Per chunk size: the pushes that sent anything (the last is `finish`),
    // as recorded before the skip.
    let cases: [(usize, [usize; 3], usize); 3] = [
        (1, [208, 270, 272], 64),
        (7, [29, 38, 39], 8),
        (64, [3, 4, 5], 0),
    ];
    for (size, sent_at, idle) in cases {
        let mut dlp = StreamingDlp::new(FirewallPolicy::Sanitize, true);
        let mut outs: Vec<String> = raw
            .as_bytes()
            .chunks(size)
            .map(|chunk| dlp.push(chunk, &scanner).unwrap().bytes)
            .collect();
        outs.push(dlp.finish(&scanner).unwrap().bytes);
        let mut want = vec![String::new(); outs.len()];
        want[sent_at[0]] = head.into_iter().map(frame).collect();
        want[sent_at[1]] = frame("again ");
        want[sent_at[2]] = "data: [DONE]\n\n".to_owned();
        assert_eq!(outs, want, "chunk size {size}");
        // Every skipped release was recomputed and released nothing.
        assert_eq!(dlp.memo.idle_hits, idle, "chunk size {size}");
    }
}
