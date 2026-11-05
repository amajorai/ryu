//! Round 36: a long run of ASCII whitespace counts against the padding cap,
//! so it no longer pins the scan start, and a keyword before it is still
//! carried to its value.

use serde_json::{json, Value};

use super::scan_test::{provider_frame, run_streaming, scanner};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn content(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|value| {
            value["choices"][0]["delta"]["content"]
                .as_str()
                .map(str::to_owned)
        })
        .collect()
}

#[test]
fn a_whitespace_run_keeps_the_scan_region_bounded() {
    let scanner = scanner();
    for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
        let mut dlp = StreamingDlp::new(policy, true);
        dlp.push(provider_frame(0, "{").as_bytes(), &scanner)
            .unwrap();
        for index in 1..20_000 {
            let frame = provider_frame(index, " \n ");
            dlp.push(frame.as_bytes(), &scanner).unwrap();
        }
        assert!(
            dlp.text.len() < 16 * 1024,
            "retained {} bytes",
            dlp.text.len()
        );
        assert!(dlp.recent.len() < 4096, "kept {} frames", dlp.recent.len());
    }
}

#[test]
fn a_keyword_before_a_long_whitespace_run_is_carried() {
    let scanner = scanner();
    let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    let mut bearer = vec!["Authorization: Bearer".to_owned()];
    bearer.extend(std::iter::repeat_n(" \n".to_owned(), 6000));
    bearer.extend([format!(" {token}"), " end.".to_owned()]);
    let mut passport = vec!["My passport".to_owned()];
    passport.extend(std::iter::repeat_n("  ".to_owned(), 6000));
    passport.extend([" AB1234567".to_owned(), " end.".to_owned()]);
    for (value, parts) in [(token, bearer), ("AB1234567", passport)] {
        let mut raw = String::new();
        for part in &parts {
            let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part } }] });
            raw.push_str(&format!("data: {frame}\n\n"));
        }
        raw.push_str("data: [DONE]\n\n");
        let offsets: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
        for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
            let (streamed, _) = run_streaming(&raw, &offsets, policy.clone(), &scanner).unwrap();
            assert!(
                !content(&streamed).contains(value),
                "{value} released under {policy:?}"
            );
        }
    }
}
