//! Round 42: a token of keywords glued end to end holds the stream whole
//! instead of walking the long-token cut back through it on every push, and
//! the release window clamps a straddling opener once text has drained.

use super::scan_test::{provider_frame, run_streaming, scanner};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn a_token_of_glued_keywords_holds_the_stream_whole() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let mut raw = String::new();
    let mut parts = vec!["Hi ".to_owned()];
    parts.extend(std::iter::repeat_n("no".repeat(500), 200));
    parts.push(" ".to_owned());
    parts.extend(std::iter::repeat_n("ok ".to_owned(), 100));
    for (index, part) in parts.iter().enumerate() {
        let frame = provider_frame(index, part);
        raw.push_str(&frame);
        dlp.push(frame.as_bytes(), &scanner).unwrap();
    }
    assert!(dlp.buffer_remaining, "the cut walked the token");
    raw.push_str("data: [DONE]\n\n");
    let (streamed, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(!blocked);
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert_eq!(streamed, buffered);
}

#[test]
fn a_straddling_opener_is_clamped_to_the_window_after_draining() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let mut index = 0;
    let mut push = |dlp: &mut StreamingDlp, text: &str| {
        index += 1;
        dlp.push(provider_frame(index, text).as_bytes(), &scanner)
            .unwrap();
    };
    for _ in 0..2000 {
        push(&mut dlp, "word ");
    }
    assert!(dlp.base > 5000, "nothing drained");
    push(&mut dlp, "data:");
    let blob_start = dlp.len();
    for _ in 0..20 {
        push(&mut dlp, &"aGk0".repeat(25));
    }
    push(&mut dlp, " ");
    for _ in 0..20 {
        push(&mut dlp, "ok ");
    }
    // Frames wholly behind the 192-byte window go out; only the blob's
    // tail waits.
    assert!(
        dlp.released_end > blob_start + 1000,
        "released to {} (blob at {blob_start})",
        dlp.released_end
    );
}
