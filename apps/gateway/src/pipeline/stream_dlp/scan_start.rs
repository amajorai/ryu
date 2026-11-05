//! Where the scan region starts behind a release: far enough back that
//! matches touching new text see the context a scan of the whole text sees,
//! and no further, so per-frame work stays bounded.

use super::digits::{chain_start, DIGIT_RUN_REACH};
use super::reach::{is_padding, is_padding_token, is_script_boundary, PADDING_REACH};
use super::spans::replaced_spans;
use super::{
    is_boundary_space, redact, StreamingDlp, BOUNDED_MATCH_LEN, SCAN_BACK, SCAN_BACK_TOKENS,
};
use crate::config::FirewallPolicy;
use crate::firewall::FirewallBackend;

/// Where a walk back from a position ended.
enum Walk {
    /// The scan start, and whether the stream should be held whole.
    Start(usize, bool),
    /// Inside a whitespace-free token that reaches far behind the reach: a
    /// candidate start in it (relative offset).
    Long(usize),
}

impl StreamingDlp {
    /// The scan start behind `position`: `SCAN_BACK` visible bytes back to a
    /// token start, then over `SCAN_BACK_TOKENS` more tokens and the
    /// whitespace between them, never before the retained text. `true` when
    /// no start a scan of the whole text would give is within reach (a group
    /// chain longer than [`DIGIT_RUN_REACH`], or a long run of stripped
    /// characters): the stream is then held whole.
    pub(super) fn scan_start_checked(
        &mut self,
        position: usize,
        scanner: &dyn FirewallBackend,
    ) -> (usize, bool) {
        let (start, cut) = match self.scan_start_walk(position, true) {
            Walk::Start(start, cut) => (start, cut),
            Walk::Long(cut) => match self.long_cut_safe(cut, position, scanner) {
                Some(true) => (self.base + cut, false),
                // A closed long token that cannot be cut (its tail holds a
                // replaced value): walking it whole would pin the start and
                // rescan it on every push, so hold the rest whole unless the
                // walk moves on.
                verdict => match self.scan_start_walk(position, false) {
                    Walk::Start(start, cut)
                        if cut || verdict.is_none() || start > self.scan_from =>
                    {
                        (start, cut)
                    }
                    _ => (position, true),
                },
            },
        };
        if !cut && self.replacement_crosses(start, scanner) {
            return (position, true);
        }
        (start, cut)
    }

    /// Whether a replacement the whole text makes runs across `start`
    /// (absolute) near a digit: a bearer value or a phone that runs into a
    /// group chain is replaced before the card rule groups the rest, so a
    /// region starting inside it would group the chain differently. Judged
    /// with the Sanitize rules whenever the policy is Sanitize, since a later
    /// violation turns them on. The carried form counts too: a bearer form
    /// padded past every reach still replaces its value first.
    fn replacement_crosses(&self, start: usize, scanner: &dyn FirewallBackend) -> bool {
        let at = start.saturating_sub(self.base).min(self.text.len());
        // Already held whole: the final step judges everything.
        if self.buffer_remaining
            || at == 0
            || !self.text[at..].chars().take(64).any(char::is_numeric)
        {
            return false;
        }
        let mut from = at.saturating_sub(PADDING_REACH + SCAN_BACK);
        while !self.text.is_char_boundary(from) {
            from += 1;
        }
        // A carried form (its keyword drained past any reach) continues into
        // the window while everything before it is still padding, which the
        // patterns take any run of, so the form joins the window directly.
        let carried = self
            .carried_raw
            .as_deref()
            .filter(|_| self.text[..from].chars().all(is_padding))
            .unwrap_or_default();
        let mut to = (at + 2 * BOUNDED_MATCH_LEN).min(self.text.len());
        while !self.text.is_char_boundary(to) {
            to += 1;
        }
        let window = format!("{carried}{}", &self.text[from..to]);
        let sanitize = self.sanitize || (self.enforce && self.policy == FirewallPolicy::Sanitize);
        let whole = redact::Transform::new(scanner, sanitize).apply(&window);
        if whole == window {
            return false;
        }
        let local = carried.len() + at - from;
        replaced_spans(&window, &whole).is_none_or(|spans| {
            spans
                .iter()
                .any(|(begin, end)| *begin < local && local < *end)
        })
    }

    /// The walk behind [`Self::scan_start_checked`]. `bounded` stops it in a
    /// whitespace-free token reaching more than [`PADDING_REACH`] behind the
    /// free reach ([`Walk::Long`]); unbounded, it follows every token to its
    /// start.
    fn scan_start_walk(&self, position: usize, bounded: bool) -> Walk {
        // Inside the open chain that already outgrew the reach (and holds the
        // stream whole): the walk could only end at its floor.
        let chain = self.len().saturating_sub(self.run.chain.length);
        if self.run.chain.open() && self.run.chain.length > DIGIT_RUN_REACH && chain <= position {
            return Walk::Start(position, true);
        }
        let bytes = self.text.as_bytes();
        let position = position.max(self.base);
        let (start, capped) = self.back_visible_capped(position, SCAN_BACK);
        if capped {
            return Walk::Start(position, true);
        }
        let mut index = start - self.base;
        // Padding-only tokens (`#`, `:`, non-ASCII spaces, ...) do not count:
        // keyword-padding patterns accept any number of them between the
        // keyword and the value, like a run of ASCII whitespace. Past the cap
        // every token counts again.
        let free_limit = position
            .saturating_sub(SCAN_BACK + PADDING_REACH)
            .max(self.base)
            - self.base;
        let long_floor = if bounded {
            free_limit.saturating_sub(PADDING_REACH)
        } else {
            0
        };
        // Back to the start of the token containing `index`.
        let walk_from = index;
        index = self.token_start(index, long_floor);
        if self.stopped_in_token(index, walk_from, long_floor) {
            // No cut that can be judged near the floor: hold the rest whole.
            return self
                .long_cut(walk_from, free_limit)
                .map_or(Walk::Start(position, true), Walk::Long);
        }
        let mut budget = SCAN_BACK_TOKENS;
        while budget > 0 && index > 0 {
            // ASCII whitespace is free only within the padding cap too: a
            // longer run (runaway JSON-mode whitespace) would otherwise pin
            // the start, and a keyword before it is carried (`keyword_tail`).
            while index > free_limit && is_boundary_space(bytes[index - 1]) {
                index -= 1;
            }
            let token_end = index;
            index = self.token_start(index, long_floor);
            if self.stopped_in_token(index, token_end, long_floor) {
                return self
                    .long_cut(token_end, free_limit)
                    .map_or(Walk::Start(position, true), Walk::Long);
            }
            if index == token_end {
                // A lone CJK character at `index - 1`... step over it.
                if let Some(previous) = self.text[..index].chars().next_back() {
                    index -= previous.len_utf8();
                }
            }
            // Token edges sit on ASCII whitespace or the start, so this slices
            // on char boundaries.
            if index < free_limit || !is_padding_token(&self.text[index..token_end]) {
                budget -= 1;
            }
        }
        // Start a group chain (cards, IBANs) where a scan of the whole text
        // would, so the same candidate partition is matched, then back to
        // that token's start so `\b` lines up (`digits.rs`). A chain longer
        // than `DIGIT_RUN_REACH` holds the stream whole instead.
        // Measured from where the walk starts: a closed chain no longer than
        // the reach that holds `index` is always walked to its true start.
        let digit_floor = index.saturating_sub(DIGIT_RUN_REACH);
        // The token edge the walk reached, kept in case the chain walk below
        // leads into a token longer than the reach.
        let edge = index;
        // The chain the text ends in, when it holds `index` and has no
        // digit, can start no candidate: skip the walk over it.
        let current = self.len().saturating_sub(self.run.chain.length);
        let lettered =
            self.run.chain.length > 0 && !self.run.chain.open() && current <= self.base + index;
        let mut cuts_chain = false;
        if !lettered {
            (index, cuts_chain) = chain_start(&self.text, index, digit_floor);
        }
        let chained = index;
        // Back over the rest of that token, whatever its characters (non-ASCII
        // letters, combining marks), so `\b` sees the context a scan of the
        // whole text sees; if the cap stops this mid-character, step forward.
        while !self.text.is_char_boundary(index) {
            index += 1;
        }
        let token_floor = if index < free_limit {
            digit_floor
        } else {
            free_limit
        };
        index = self.token_start(index, token_floor);
        while !self.text.is_char_boundary(index) {
            index += 1;
        }
        // An ideographic space kept as left context is padding: the drained
        // text must keep it, or `Bearer` before it is no longer an open form
        // (`bearer\s+`) and is not carried. It is not a word character, so
        // `\b` judges the region the same either way.
        let position_rel = position.max(self.base) - self.base;
        while index < position_rel {
            match self.text[index..].chars().next() {
                Some(next) if next.is_whitespace() && is_script_boundary(next) => {
                    index += next.len_utf8();
                }
                _ => break,
            }
        }
        // Stopped by the floor inside a token: a start there would see a word
        // boundary the whole text does not. A chain led there through a word
        // character (no candidate starts in it), so the edge is enough.
        let at_edge = index == 0
            || self.text[..index]
                .chars()
                .next_back()
                .is_some_and(|previous| {
                    previous.is_ascii_whitespace() || is_script_boundary(previous)
                })
            || self.text[index..]
                .chars()
                .next()
                .is_some_and(is_script_boundary);
        if !at_edge {
            // A chain the walk followed back into a token the floor cuts: the
            // whole text starts candidates in it (at the chain after
            // punctuation, at its second group after a word character, at its
            // first after a non-ASCII letter via `(?-u:\b)`), and `edge` would
            // group it differently, so hold the rest whole.
            if chained < edge {
                return Walk::Start(position, true);
            }
            index = edge;
        }
        Walk::Start(self.base + index, cuts_chain)
    }

    /// Whether `token_start` from `from` stopped at `floor` inside a token
    /// (not at whitespace, a CJK character or the retained text's start).
    fn stopped_in_token(&self, index: usize, from: usize, floor: usize) -> bool {
        floor > 0
            && index > 0
            && index <= floor
            && index < from
            && !self.text[..index]
                .chars()
                .next_back()
                .is_some_and(|previous| previous.is_ascii_whitespace())
            && !self.text[index..]
                .chars()
                .next()
                .is_some_and(is_script_boundary)
    }

    /// Detection over the region `from..to` (absolute). The folded carried
    /// form joins the folded region, as the whole text is folded; the form as
    /// written (when the raw text holds one) joins the raw region, as the
    /// whole text is matched as written too.
    pub(super) fn scan_region(
        &self,
        from: usize,
        to: usize,
        scanner: &dyn FirewallBackend,
    ) -> Option<crate::firewall::FirewallMatch> {
        let region = &self.text[from - self.base..to - self.base];
        match self.carried.as_deref() {
            Some(carried) if from == self.base => scanner
                .scan_outbound(&format!(
                    "{carried}{}",
                    ryu_gw_firewall::normalize_for_scan(region)
                ))
                .or_else(|| match self.carried_raw.as_deref() {
                    Some(raw) => scanner.scan_outbound(&format!("{raw}{region}")),
                    None => scanner.scan_outbound(region),
                }),
            _ => scanner.scan_outbound(region),
        }
    }
}
