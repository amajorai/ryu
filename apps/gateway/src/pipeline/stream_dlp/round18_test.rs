//! A scan start that groups `\s`-joined numbers differently from earlier
//! releases never releases a group the whole text redacts, and a delta's own
//! `choices` key is an ordinary field.

use serde_json::json;

use super::round15_test::{assert_parity, content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

#[test]
fn newline_joined_phone_groups_never_release_a_redacted_group() {
    let scanner = scanner();
    for second in ["\u{ff13}\u{ff13}\u{ff13}\n", "333\n"] {
        for padding in 0..4 {
            let mut frames = vec![content(&format!("Numbers:{}\n", " ".repeat(padding)))];
            for index in 0..160 {
                frames.push(content(if index % 2 == 0 { "1555\n" } else { second }));
            }
            frames.push(content("done."));
            let raw = sse(&frames);
            let (oracle, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize)
                    .unwrap();
            let (streamed, _) = run_streaming(
                &raw,
                &raw.match_indices("data: ")
                    .map(|(at, _)| at)
                    .collect::<Vec<_>>(),
                FirewallPolicy::Sanitize,
                &scanner,
            )
            .unwrap();
            let raw_groups = |sse: &str| sse.matches(second.trim_end()).count();
            assert!(
                raw_groups(&streamed) <= raw_groups(&oracle),
                "{second:?} {padding}: more raw groups streamed than the buffered rewrite keeps"
            );
        }
    }
}

#[test]
fn a_choices_key_inside_a_delta_keeps_its_text() {
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "Hello there", "choices": null } }] }),
        content(" friend."),
    ]);
    assert_parity(&raw);
}
