//! The scan start inside a long whitespace-free token (base64, a data URI,
//! minified JSON): where to cut it so the region sees what a scan of the
//! whole text sees, and whether that cut is safe.

use super::digits::{chain_start, is_ignorable, DIGIT_RUN_REACH};
use super::reach::{fold_case, is_script_boundary, scan_width, IGNORABLE_REACH, KEYWORDS};
use super::{redact, StreamingDlp, BOUNDED_MATCH_LEN};
use crate::firewall::FirewallBackend;

/// Characters around a long-token cut searched for a keyword it would
/// split: the longest, `passport`, with room to spare.
const KEYWORD_SPAN: usize = 16;

/// Moves a long-token cut may make to clear keywords: a few glued
/// keywords (`awspassport`), never a token made of them.
const KEYWORD_STEPS: usize = 8;

/// The words the passport form accepts between its keyword and value.
const PASSPORT_NUMBER_WORDS: [&str; 3] = ["no", "num", "number"];

impl StreamingDlp {
    /// The start inside a long token: the free reach's floor (on a char
    /// boundary), never after where the walk entered the token.
    ///
    /// Never inside a keyword (`passport`, `bearer`, ...) or the passport
    /// form's `no` / `num` / `number`, as the scan folds them (case,
    /// fullwidth and homoglyph letters): cut in two, the form would no longer
    /// be carried (`keyword_tail`), and padding of `#`, `:` and `-` lets it
    /// run on without whitespace. Any letter may precede one: a non-ASCII
    /// letter is a word boundary to the patterns' `(?-u:\b)`.
    ///
    /// A keyword starting at the cut keeps an ASCII word character before it
    /// in the region, so the region judges `\b` there as the whole text
    /// does. `None` when a run of stripped characters hides what is around
    /// the cut, or keywords glued end to end (`nonono…`) would walk it back
    /// further than [`KEYWORD_STEPS`] moves: the caller holds the rest whole
    /// rather than rescan the token on every push.
    pub(super) fn long_cut(&self, from: usize, free_limit: usize) -> Option<usize> {
        let mut cut = free_limit.min(from);
        while !self.text.is_char_boundary(cut) {
            cut += 1;
        }
        for _ in 0..KEYWORD_STEPS {
            let (across, starts) = self.keyword_across(cut)?;
            if let Some(start) = across {
                cut = start;
                continue;
            }
            let word_before = self.text[..cut]
                .chars()
                .next_back()
                .is_some_and(|previous| previous.is_ascii_alphanumeric() || previous == '_');
            if starts && word_before {
                cut -= 1;
                continue;
            }
            return Some(cut);
        }
        None
    }

    /// The start of a folded keyword occurrence that spans `cut`, and
    /// whether one starts right at it. Each side gathers [`KEYWORD_SPAN`]
    /// characters the scan keeps, skipping stripped ones (zero-width, soft
    /// hyphen); `None` when more than [`IGNORABLE_REACH`] bytes of them
    /// stand in the way.
    fn keyword_across(&self, cut: usize) -> Option<(Option<usize>, bool)> {
        let gather = |characters: &mut dyn Iterator<Item = (usize, char)>| {
            let mut taken = Vec::new();
            let mut visible = 0;
            for (index, character) in characters {
                if index.abs_diff(cut) > IGNORABLE_REACH {
                    return None;
                }
                visible += usize::from(!is_ignorable(character));
                taken.push((index, character));
                if visible == KEYWORD_SPAN {
                    break;
                }
            }
            Some(taken)
        };
        let mut before = gather(&mut self.text[..cut].char_indices().rev())?;
        before.reverse();
        let after = gather(
            &mut self.text[cut..]
                .char_indices()
                .map(|(offset, character)| (cut + offset, character)),
        )?;
        // Folded text around the cut, each byte mapped to its raw start.
        let mut folded = String::new();
        let mut origin = Vec::new();
        let mut folded_cut = None;
        let mut buffer = [0u8; 4];
        for (index, character) in before.into_iter().chain(after) {
            if index == cut {
                folded_cut = Some(folded.len());
            }
            let piece = fold_case(&ryu_gw_firewall::normalize_for_scan(
                character.encode_utf8(&mut buffer),
            ));
            origin.extend(std::iter::repeat_n(index, piece.len()));
            folded.push_str(&piece);
        }
        let folded_cut = folded_cut.unwrap_or(folded.len());
        let occurrences: Vec<(usize, usize)> = KEYWORDS
            .iter()
            .chain(&PASSPORT_NUMBER_WORDS)
            .flat_map(|keyword| {
                folded
                    .match_indices(keyword)
                    .map(move |(at, _)| (at, at + keyword.len()))
            })
            .collect();
        let across = occurrences
            .iter()
            // Ending right at the cut counts too: `bearer` needs its padding
            // to be carried, so a cut right after it would lose the form.
            .filter(|(start, end)| *start < folded_cut && *end >= folded_cut)
            .map(|(start, _)| origin[*start])
            .min();
        let starts = occurrences.iter().any(|(start, _)| *start == folded_cut);
        Some((across, starts))
    }

    /// Whether the scan may start at relative `cut` inside a long token
    /// (base64, a data URI, minified JSON) without seeing anything a scan of
    /// the whole text would not. The token's part before `cut` was judged
    /// whole when the token closed, and only bounded matches (at most
    /// [`BOUNDED_MATCH_LEN`]) run from a token into later text, so they start
    /// in its tail with their whole-text context. What the cut changes is the
    /// region's own start, so:
    /// - the token must close before `position`, more than a bounded match
    ///   after the cut;
    /// - the cut must not split a group chain (cards, IBANs);
    /// - the token from the cut, on its own, must hold no match and be left
    ///   unchanged by the transform (a false word boundary at the cut finds
    ///   nothing);
    /// - the frames released over it went out unchanged (checked once per
    ///   token), so the region's transform agrees with what was sent.
    ///
    /// `None` while that cannot be judged yet (the token still open behind
    /// `position`, or closing within a bounded match of the cut).
    pub(super) fn long_cut_safe(
        &mut self,
        cut: usize,
        position: usize,
        scanner: &dyn FirewallBackend,
    ) -> Option<bool> {
        // The token may close past the release (a cut held at an opener
        // inside it): look up to the last scanned boundary.
        let limit = (self.last_space.max(position).max(self.base) - self.base).min(self.text.len());
        if cut >= limit {
            return None;
        }
        let Some(offset) = self.text[cut..limit].find(|character: char| {
            character.is_ascii_whitespace() || is_script_boundary(character)
        }) else {
            return None;
        };
        let end = cut + offset;
        // Measured as the window is (`scan_width`): TAG or zero-width padding
        // in the tail must not pass for a bounded match's length.
        let mut width = 0;
        if !self.text[cut..end].chars().any(|character| {
            width += scan_width(character);
            width > BOUNDED_MATCH_LEN
        }) {
            return None;
        }
        let (chained, cuts) = chain_start(&self.text, cut, cut.saturating_sub(DIGIT_RUN_REACH));
        if chained != cut || cuts {
            return Some(false);
        }
        let tail = &self.text[cut..end];
        if scanner.scan_outbound(tail).is_some()
            || redact::Transform::new(scanner, self.sanitize).apply(tail) != tail
        {
            return Some(false);
        }
        let (cut_at, end_at) = (self.base + cut, self.base + end);
        if let Some((key, sent_raw)) = self.long_token {
            if key == end_at {
                return Some(sent_raw);
            }
        }
        let sent_raw = self
            .recent
            .iter()
            .filter(|frame| frame.end > cut_at && frame.start < end_at)
            .all(|frame| {
                frame.start >= self.base
                    && frame.sent == self.text[frame.start - self.base..frame.end - self.base]
            });
        self.long_token = Some((end_at, sent_raw));
        Some(sent_raw)
    }
}
