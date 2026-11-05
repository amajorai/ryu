//! Round 37: a long whitespace-free token no longer pins the scan start
//! (each later frame would rescan it whole), and token ids that may run
//! ahead of their frame's text are judged with the whole stream.

use serde_json::{json, Value};

use super::scan_test::{provider_frame, run_streaming, scanner};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn a_long_token_keeps_the_scan_region_bounded() {
    let scanner = scanner();
    for (piece, policy) in [
        ("QUJD", FirewallPolicy::Block),
        ("QUJD", FirewallPolicy::Sanitize),
        ("x/y+", FirewallPolicy::WarnAndContinue),
    ] {
        let mut dlp = StreamingDlp::new(policy.clone(), true);
        let mut raw = String::new();
        let mut push = |dlp: &mut StreamingDlp, index: usize, text: &str| {
            let frame = provider_frame(index, text);
            raw.push_str(&frame);
            dlp.push(frame.as_bytes(), &scanner).unwrap();
        };
        push(&mut dlp, 0, "Image: ");
        for index in 1..16_384 {
            push(&mut dlp, index, piece);
        }
        // From the second word on (the first judges the token whole), the
        // retained text and sent records stay bounded while the token is
        // still within the reach.
        for index in 0..200 {
            push(&mut dlp, 16_384 + index, " ok");
            if index >= 1 {
                assert!(
                    dlp.text.len() < 16 * 1024,
                    "{piece}/{index}: retained {} bytes",
                    dlp.text.len()
                );
                assert!(
                    dlp.recent.len() < 4096,
                    "{piece}/{index}: kept {}",
                    dlp.recent.len()
                );
            }
        }
        // The clean stream still equals the buffered rewrite.
        raw.push_str("data: [DONE]\n\n");
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        assert!(!blocked);
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert_eq!(streamed, buffered, "{piece}");
    }
}

#[test]
fn a_secret_after_a_long_token_is_still_caught() {
    let scanner = scanner();
    let mut parts = vec!["Blob: ".to_owned()];
    parts.extend(std::iter::repeat_n("QUJD".to_owned(), 4096));
    parts.extend(std::iter::repeat_n(" ok".to_owned(), 120));
    parts.extend([" key ".to_owned(), "sk-proj-".to_owned()]);
    parts.extend([
        "AbCdEfGh".to_owned(),
        "IjKlMnOp".to_owned(),
        "QrStUvWx ok".to_owned(),
    ]);
    let mut raw = String::new();
    for (index, part) in parts.iter().enumerate() {
        raw.push_str(&provider_frame(index, part));
    }
    raw.push_str("data: [DONE]\n\n");
    for policy in [
        FirewallPolicy::WarnAndContinue,
        FirewallPolicy::Sanitize,
        FirewallPolicy::Block,
    ] {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        assert!(
            !streamed.contains("IjKlMnOp"),
            "{policy:?}: secret released"
        );
    }
}

fn vllm(content: &str, ids: &[u64], role: bool) -> Value {
    let mut delta = json!({ "content": content });
    if role {
        delta["role"] = json!("assistant");
    }
    json!({ "id": "c1", "object": "chat.completion.chunk", "model": "m",
        "choices": [{ "index": 0, "delta": delta, "logprobs": null,
            "finish_reason": null, "token_ids": ids }] })
}

#[test]
fn token_ids_running_ahead_of_the_text_never_leave_with_a_changed_stream() {
    let scanner = scanner();
    let frames = [
        vllm("Key: ", &[101, 102, 103, 104], true),
        vllm(
            "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx ok",
            &[105, 106, 107],
            false,
        ),
    ];
    let mut raw = String::new();
    for frame in &frames {
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    for policy in [
        FirewallPolicy::WarnAndContinue,
        FirewallPolicy::Sanitize,
        FirewallPolicy::Block,
    ] {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        for out in [&streamed, &buffered] {
            assert!(!out.contains("AbCdEf"), "{policy:?}: {out}");
            assert!(!out.contains("104"), "{policy:?}: {out}");
        }
    }
    // A clean vLLM stream keeps its token ids.
    let clean = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        vllm("Hello ", &[9707], true),
        vllm("world.", &[1879, 13], false)
    );
    let (streamed, _) =
        run_streaming(&clean, &offsets(&clean), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert!(streamed.contains("1879"), "{streamed}");
}
