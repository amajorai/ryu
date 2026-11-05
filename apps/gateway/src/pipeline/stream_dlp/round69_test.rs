//! Round 69: refusal-shaped frames count towards the held limit (and only
//! the first is set apart), and envelope state stays bounded per stream.

use serde_json::json;

use super::scan_test::scanner;
use super::StreamingDlp;
use crate::config::FirewallPolicy;

#[test]
fn refusal_shaped_frames_count_towards_the_held_limit() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let message = "a".repeat(1024 * 1024);
    let mut refused = false;
    for _ in 0..20 {
        let frame = json!({ "error": { "code": "invalid_api_key", "message": message } });
        if dlp
            .push(format!("data: {frame}\n\n").as_bytes(), &scanner)
            .is_err()
        {
            refused = true;
            break;
        }
    }
    assert!(refused, "20 MiB of refusal-shaped frames were not refused");
}

#[test]
fn a_field_changing_every_other_frame_keeps_no_history() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    for index in 0..4000 {
        let mut frame = json!({ "choices": [{ "index": 0, "delta": { "content": " w" } }] });
        if index % 2 == 0 {
            frame["note"] = json!(format!("{index}-{}", "x".repeat(1024)));
        }
        dlp.push(format!("data: {frame}\n\n").as_bytes(), &scanner)
            .unwrap();
    }
    assert!(!dlp.buffer_remaining, "held whole");
    assert!(
        dlp.envelope.retained_runs() < 8,
        "kept {}",
        dlp.envelope.retained_runs()
    );
}
