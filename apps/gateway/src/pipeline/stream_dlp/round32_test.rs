//! A zero-width run longer than the reach cap never lets out an opener
//! before it.

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

#[test]
fn a_zero_width_run_never_releases_the_head_of_a_phone_number() {
    let scanner = scanner();
    for lead in ["Call 1 (555)", "Tel(555)"] {
        let raw = sse(&[
            content(lead),
            content(&"\u{200b}".repeat(22_000)),
            content(" 123-4567"),
            content(" ok "),
        ]);
        let splits: Vec<_> = raw.match_indices("data: ").map(|(at, _)| at).collect();
        let (streamed, blocked) =
            run_streaming(&raw, &splits, FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{lead}");
        assert!(!streamed.contains("(555)"), "{lead}");
    }
}
