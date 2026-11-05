//! Nothing follows a block notice: a held-whole stream whose final step is
//! split into a text-level head and the rest stops once the head's release
//! refuses a Sanitize survivor.

use serde_json::json;

use super::super::scan_test::scanner;
use super::super::*;

#[test]
fn a_refused_final_head_releases_nothing_after_its_notice() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Sanitize, true);
    // Held whole, so the final step releases every frame in one advance:
    // the plain content head first, then the rest from the tool call on.
    dlp.buffer_remaining = true;
    let mut raw = String::new();
    for content in ["hi ", "there "] {
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": content } }] });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    let tool = json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
        { "index": 0, "function": { "name": "lookup", "arguments": "{}" } }
    ] } }] });
    let tail = json!({ "choices": [{ "index": 0, "delta": { "content": "after" } }] });
    raw.push_str(&format!("data: {tool}\n\ndata: {tail}\n\ndata: [DONE]\n\n"));
    let mut out = String::new();
    for line in raw.split_inclusive("\n\n") {
        out.push_str(&dlp.push(line.as_bytes(), &scanner).unwrap().bytes);
    }
    assert!(out.is_empty(), "{out}");
    // The head's refusal is a backstop the ingest-side checks (envelope
    // lanes, the fail-closed transform) normally pre-empt, so its inputs are
    // set directly: a field beside `choices` joining an SSN only across the
    // two head frames, and a carried keyword whose match reaches the region,
    // which sends the head down the per-string path that checks survivors.
    assert_eq!(dlp.held.len(), 4);
    dlp.held[0].value["x"] = json!("ssn 123-45");
    dlp.held[1].value["x"] = json!("-6789");
    dlp.carried_raw = Some("ssn 987-65-4321 ".to_owned());
    // An earlier match turned Sanitize on.
    dlp.sanitize = true;
    // The final step splits off the two content frames as its head.
    assert_eq!(dlp.final_head(4, &scanner), (2, true));
    let last = dlp.finish(&scanner).unwrap();
    out.push_str(&last.bytes);
    assert!(last.blocked, "{out}");
    assert_eq!(out.matches("[Ryu firewall]").count(), 1, "{out}");
    let (_, after) = out.split_once("could not be redacted").expect("notice");
    // Only the rest of the notice frame and its `[DONE]`.
    let (_, rest) = after.split_once("\n\n").expect("notice frame end");
    assert_eq!(rest, "data: [DONE]\n\n", "frames after the notice: {out}");
    assert!(!out.contains("after"), "{out}");
}
