//! A text copy is judged against the field it follows in any frame, and
//! OpenRouter's other reasoning entry shapes keep the stream incremental.

use serde_json::{json, Value};

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn joined(sse: &str, pointer: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

#[test]
fn a_text_copy_skipped_in_a_frame_with_two_fields_is_judged_whole() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "text": "sk-abcdefghij",
            "delta": { "reasoning_content": "sk-abcdefghij" } }] }),
        content("hello"),
        json!({ "choices": [{ "index": 0, "delta": { "content": "x", "reasoning_content": " " } }] }),
        json!({ "choices": [{ "index": 0, "text": "klmnopqrstuvwxyz",
            "delta": { "reasoning_content": "klmnopqrstuvwxyz" } }] }),
    ]);
    let splits: Vec<_> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    let (_, blocked) = run_streaming(&raw, &splits, FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (streamed, _) = run_streaming(&raw, &splits, policy.clone(), &scanner).unwrap();
        assert!(
            !joined(&streamed, "/choices/0/text").contains("sk-abcdefghijklmnopqrstuvwxyz"),
            "{policy:?}: {streamed}"
        );
    }
}

#[test]
fn openrouter_signature_summary_and_encrypted_entries_keep_streaming() {
    let scanner = scanner();
    let entry = |reasoning: &str, entry: Value| {
        json!({ "choices": [{ "index": 0, "delta": { "content": "", "reasoning": reasoning,
            "reasoning_details": [entry] } }] })
    };
    let text = |reasoning: &str, format: &str| {
        entry(
            reasoning,
            json!({ "type": "reasoning.text", "text": reasoning,
            "format": format, "index": 0 }),
        )
    };
    let providers = [
        // Anthropic: text entries, then the signature.
        vec![
            text("Let me think. ", "anthropic-claude-v1"),
            entry(
                "",
                json!({ "type": "reasoning.text", "signature": "EqQBCkgIBhABGAIiQ",
                "format": "anthropic-claude-v1", "index": 0 }),
            ),
        ],
        // OpenAI: summary entries.
        vec![
            entry(
                "Thinking it over. ",
                json!({ "type": "reasoning.summary",
                "summary": "Thinking it over. ", "format": "openai-responses-v1", "index": 0 }),
            ),
            entry(
                "Done. ",
                json!({ "type": "reasoning.summary", "summary": "Done. ",
                "format": "openai-responses-v1", "index": 0 }),
            ),
        ],
        // Gemini: text entries, then an encrypted one.
        vec![
            text("Let me think. ", "google-gemini-v1"),
            entry(
                "",
                json!({ "type": "reasoning.encrypted", "data": "gAAAAB",
                "format": "google-gemini-v1", "index": 0 }),
            ),
        ],
    ];
    for (provider, reasoning) in providers.into_iter().enumerate() {
        let mut dlp = super::StreamingDlp::new(FirewallPolicy::Sanitize, true);
        let mut early = String::new();
        let frames = reasoning
            .into_iter()
            .chain(["Hello ", "there ", "friend. "].map(content));
        for frame in frames {
            early.push_str(
                &dlp.push(format!("data: {frame}\n\n").as_bytes(), &scanner)
                    .unwrap()
                    .bytes,
            );
        }
        assert!(
            joined(&early, "/choices/0/delta/content").contains("Hello"),
            "provider {provider}: {early}"
        );
    }
}
