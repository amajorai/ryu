//! Token mirrors (logprobs, token ids) go with the text they mirror, the
//! zero-width cap holds the stream whole, and the scan start never lands
//! inside a token.

use serde_json::json;

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn splits(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn logprob_tokens_do_not_keep_a_redacted_value() {
    let scanner = scanner();
    let token =
        |text: &str| json!({ "token": text, "logprob": -0.1, "bytes": [32], "top_logprobs": [] });
    let raw = sse(&[json!({ "choices": [{ "index": 0,
        "delta": { "role": "assistant", "content": "key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx ok" },
        "logprobs": { "content": [token("key"), token(" sk"), token("-proj-AbCd"),
            token("EfGhIjKlMn"), token("OpQrStUvWx"), token(" ok")] },
        "finish_reason": null }] })]);
    for policy in [
        FirewallPolicy::Block,
        FirewallPolicy::Sanitize,
        FirewallPolicy::WarnAndContinue,
    ] {
        let (streamed, _) = run_streaming(&raw, &splits(&raw), policy.clone(), &scanner).unwrap();
        assert!(!streamed.contains("EfGhIjKlMn"), "{policy:?}: {streamed}");
        let (rewritten, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(!rewritten.contains("EfGhIjKlMn"), "buffered {policy:?}");
    }
}

#[test]
fn token_ids_of_redacted_text_are_dropped() {
    let scanner = scanner();
    let frames: Vec<_> = ["password", "=", "hun", "ter", "22", " ok"]
        .iter()
        .enumerate()
        .map(|(index, text)| {
            json!({ "choices": [{ "index": 0, "text": text,
                "delta": { "token_id": 90001 + index, "content": text } }] })
        })
        .collect();
    let raw = sse(&frames);
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (streamed, _) = run_streaming(&raw, &splits(&raw), policy.clone(), &scanner).unwrap();
        for id in 90001..=90005 {
            assert!(
                !streamed.contains(&id.to_string()),
                "{policy:?} {id}: {streamed}"
            );
        }
        let (rewritten, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        for id in 90001..=90005 {
            assert!(
                !rewritten.contains(&id.to_string()),
                "buffered {policy:?} {id}"
            );
        }
    }
}

#[test]
fn a_capped_cut_holds_the_stream_whole() {
    let scanner = scanner();
    let mut dlp = super::StreamingDlp::new(FirewallPolicy::Block, true);
    dlp.push(format!("data: {}\n\n", content("ok ")).as_bytes(), &scanner)
        .unwrap();
    let frame = format!(
        "data: {}\n\n",
        content(&format!("{}a ", "\u{200b}".repeat(230)))
    );
    for _ in 0..200 {
        dlp.push(frame.as_bytes(), &scanner).unwrap();
    }
    assert!(dlp.buffer_remaining);
    dlp.finish(&scanner).unwrap();
}

#[test]
fn the_scan_start_never_lands_inside_a_long_token() {
    let scanner = scanner();
    let mut frames = vec![
        content("Intro "),
        content(&format!("xGB29NWBK60161331926819.{}7", "y".repeat(4060))),
        content(" Then "),
    ];
    frames.extend((0..140).map(|_| content("a ")));
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    let (_, blocked) = run_streaming(&raw, &splits(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert_eq!(blocked, oracle.is_some());
}
