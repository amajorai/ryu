//! How far back the scan region reaches behind a position.
//!
//! Detection normalizes text before matching (`normalize_for_scan` strips
//! zero-width characters and folds other spaces), so distances here are
//! measured on visible text, and padding is judged on the normalized form.

use super::digits::{Chain, DIGIT_RUN_REACH};
use super::{StreamingDlp, BOUNDED_MATCH_LEN};

/// How far behind the reach a run of padding-only tokens may extend it for
/// free. Without a cap, a response made of `#` / `-` tokens would pin the
/// scan start and rescan everything on every step.
pub(super) const PADDING_REACH: usize = 4096;

/// Raw bytes of characters the scan strips (zero-width and similar) a reach
/// may walk over besides its visible bytes. Past it the stream is held whole
/// (`move_scan_start`) rather than rescanning megabytes on every push.
pub(super) const IGNORABLE_REACH: usize = 64 * 1024;

/// Characters keyword-padding patterns accept between a keyword and its value
/// (`Bearer\s+`, `passport[\s:#-]*`, `api_key\s*[:=]\s*`, `no.`).
pub(super) fn is_padding(character: char) -> bool {
    character.is_whitespace() || matches!(character, ':' | '#' | '-' | '=' | '.')
}

/// A token the keyword-padding patterns would accept as padding once
/// normalized (a token that normalizes to nothing counts too).
pub(super) fn is_padding_token(token: &str) -> bool {
    ryu_gw_firewall::normalize_for_scan(token)
        .chars()
        .all(is_padding)
}

/// A character's length in the scan view the release window is measured in:
/// TAG characters (`U+E0000..=U+E007F`) count for nothing, every other
/// character for its [`ryu_gw_firewall::fold_for_redaction`] fold, so
/// zero-width and combining characters count 0 and a fullwidth digit 1. A
/// bounded match is at most [`BOUNDED_MATCH_LEN`] of these bytes long however
/// many raw bytes it spans.
pub(super) fn scan_width(character: char) -> usize {
    if character.is_ascii() {
        return 1;
    }
    if ('\u{E0000}'..='\u{E007F}').contains(&character) {
        return 0;
    }
    let mut buffer = [0u8; 4];
    ryu_gw_firewall::fold_for_redaction(character.encode_utf8(&mut buffer)).len()
}

/// Whether a (normalized) token could begin a built-in match that may contain
/// whitespace and so still be open at the scan end: phone, SSN, card and IBAN
/// forms all carry (Unicode) digits in their first token, the AWS secret form starts at
/// `aws`, and a PEM header at `-----`. Keyword-padding forms (`Bearer`,
/// `api_key =`, `passport no.`) are held too, so their value usually arrives
/// before the keyword is released and is redacted exactly; past the window
/// the scan-back reach still keeps the keyword in view (fail-closed mask).
pub(super) fn opens_bounded_match(token: &str) -> bool {
    // ASCII tokens (nearly all prose) are judged over bytes, with no folding
    // or allocation: the only ASCII numerics are `0-9`.
    if token.is_ascii() {
        let bytes = token.as_bytes();
        let contains = |keyword: &[u8]| {
            bytes
                .windows(keyword.len())
                .any(|window| window.eq_ignore_ascii_case(keyword))
        };
        return bytes.iter().any(u8::is_ascii_digit)
            || contains(b"-----")
            || KEYWORDS.iter().any(|keyword| contains(keyword.as_bytes()));
    }
    // `\d` is Unicode (Arabic-Indic, Devanagari, mathematical digits, ...).
    if token.chars().any(char::is_numeric) || token.contains("-----") {
        return true;
    }
    let lower = fold_case(token);
    KEYWORDS.iter().any(|keyword| lower.contains(keyword))
}

/// The openings of the forms whose classes (`[^\s]`, `[^&\s"']`) take CJK
/// characters, so they run on through CJK release boundaries until ASCII
/// whitespace: `db_connection` and `secret_param`.
const UNBOUNDED_FORMS: [&str; 8] = [
    "mongodb://",
    "postgres://",
    "postgresql://",
    "mysql://",
    "redis://",
    "password=",
    "passwd=",
    "secret=",
];

/// Whether folded run text holds the opening of an unbounded form. The run is
/// then held from that form's token (`track_run`).
fn opens_unbounded_form(folded: &str) -> bool {
    UNBOUNDED_FORMS.iter().any(|form| folded.contains(form))
}

/// The current ASCII-whitespace-free run (`StreamingDlp::track_run`).
#[derive(Default)]
pub(super) struct Run {
    /// Absolute start of the run.
    pub(super) start: usize,
    /// Whether it holds a form whose classes run on through CJK text.
    pub(super) open_form: bool,
    /// Absolute start of the token the open form is held from.
    pub(super) form_start: usize,
    /// Normalized, case-folded tail of the run, for forms split across
    /// frames.
    pub(super) tail: String,
    /// The group chain the text ends in (`digits.rs`).
    pub(super) chain: Chain,
    /// Something the scan sees (not zero-width) follows the last boundary.
    pub(super) visible_after_space: bool,
    /// `(base, chain start, open form, form start)` of the last chain hold
    /// point and its `(token start, release cut)` (`before_open_chain`).
    pub(super) hold_memo: Option<((usize, usize, bool, usize), (usize, usize))>,
}

/// Characters of folded run tail kept to catch a form split across frames:
/// at least the longest form less one.
const RUN_TAIL: usize = 16;

/// Whether `character` belongs to a digit-group run (cards, IBANs, phones)
/// once normalized for the scan: a digit, a space or a dash, or nothing.
/// Characters that end a release run besides ASCII whitespace: CJK
/// ideographs, kana and hangul (and the ideographic space). Text in these
/// scripts has no spaces, and no built-in pattern's ASCII classes take them;
/// the patterns whose classes do are held by [`opens_bounded_match`].
/// Fullwidth forms are not boundaries: they normalize to ASCII.
pub(super) fn is_script_boundary(character: char) -> bool {
    matches!(u32::from(character),
        0x3000..=0x303F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xAC00..=0xD7AF | 0xF900..=0xFAFF)
}

/// Keywords that open a keyword-padding or bounded match (lowercase).
pub(super) const KEYWORDS: [&str; 6] =
    ["aws", "bearer", "api_key", "apikey", "api-key", "passport"];

/// Lowercase as `(?i)` matching sees it: Unicode simple case folding also maps
/// the long s (U+017F) to `s` and the Kelvin sign (U+212A) to `k`.
pub(super) fn fold_case(token: &str) -> String {
    if token.is_ascii() {
        return token.to_ascii_lowercase();
    }
    let mut folded = String::with_capacity(token.len());
    fold_case_into(token, &mut folded);
    folded
}

/// [`fold_case`] appended to `out`. An ASCII character's lowercase is always
/// the one character `to_ascii_lowercase` gives.
pub(super) fn fold_case_into(token: &str, out: &mut String) {
    if token.is_ascii() {
        out.extend(
            token
                .bytes()
                .map(|byte| char::from(byte.to_ascii_lowercase())),
        );
        return;
    }
    out.extend(token.chars().map(|character| match character {
        character if character.is_ascii() => character.to_ascii_lowercase(),
        '\u{17F}' => 's',
        '\u{212A}' => 'k',
        // Only a one-character lowercase: `(?i)` simple folding has no
        // mapping for `İ` (lowercase `i̇`), so it stays as written.
        other => {
            let mut lower = other.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(single), None) => single,
                _ => other,
            }
        }
    }));
}

impl StreamingDlp {
    /// The start of the token containing relative offset `index`, not before
    /// `floor`: just after ASCII whitespace, or at a CJK character (kept as
    /// one character of left context, so `\b` judges the region as it judges
    /// the whole text). `index` is a char boundary; so is the result.
    pub(super) fn token_start(&self, mut index: usize, floor: usize) -> usize {
        while index > floor {
            let Some(previous) = self.text[..index].chars().next_back() else {
                break;
            };
            if previous.is_ascii_whitespace() {
                break;
            }
            index -= previous.len_utf8();
            if is_script_boundary(previous) {
                break;
            }
        }
        index
    }

    /// Follow the ASCII-whitespace-free run the newly appended text (from
    /// relative offset `appended`) extends: where it starts, and whether (and
    /// from which token) it holds an unbounded form (see
    /// [`opens_unbounded_form`]).
    pub(super) fn track_run(&mut self, appended: usize) {
        let new = &self.text[appended..];
        self.run.chain.extend(new);
        // Past the reach, the scan start could only cut into the chain and
        // group it differently from a scan of the whole text.
        self.buffer_remaining |= self.run.chain.open() && self.run.chain.length > DIGIT_RUN_REACH;
        let segment = match new.rfind(|character: char| character.is_ascii_whitespace()) {
            Some(space) => {
                self.run.start = self.base + appended + space + 1;
                self.run.open_form = false;
                self.run.tail.clear();
                &new[space + 1..]
            }
            None => new,
        };
        let segment_start = self.text.len() - segment.len();
        let mut folded = std::mem::take(&mut self.run.tail);
        fold_case_into(&ryu_gw_firewall::normalize_for_scan(segment), &mut folded);
        if !self.run.open_form && opens_unbounded_form(&folded) {
            self.run.open_form = true;
            // The form starts in the kept tail at the earliest: hold from the
            // token holding the tail's first character. Tokens before it are
            // complete, as any other CJK-delimited token is.
            let floor = self.run.start.saturating_sub(self.base);
            let mut index = segment_start;
            let mut remaining = RUN_TAIL;
            let mut buffer = [0u8; 4];
            while remaining > 0 && index > floor {
                let Some(previous) = self.text[..index].chars().next_back() else {
                    break;
                };
                index -= previous.len_utf8();
                if previous.is_ascii()
                    || !ryu_gw_firewall::normalize_for_scan(previous.encode_utf8(&mut buffer))
                        .is_empty()
                {
                    remaining -= 1;
                }
            }
            self.run.form_start = self.base + self.token_start(index, floor);
        }
        let keep = folded.chars().count().saturating_sub(RUN_TAIL);
        let cut = folded
            .char_indices()
            .nth(keep)
            .map_or(folded.len(), |(index, _)| index);
        folded.drain(..cut);
        self.run.tail = folded;
    }

    /// How far frames may be released after scanning up to `safe_end`.
    ///
    /// Whitespace-free matches before `safe_end` are complete (it follows
    /// whitespace). A match that can contain whitespace is at most
    /// [`BOUNDED_MATCH_LEN`] long, so one still open at `safe_end` starts in the
    /// window behind it, at a token [`opens_bounded_match`] flags. The cut is
    /// the start of the earliest such token, or `safe_end` when there is none:
    /// prose streams word by word instead of trailing 192 bytes behind.
    pub(super) fn release_cut(&self, safe_end: usize) -> usize {
        self.release_cut_checked(safe_end).0
    }

    /// [`Self::release_cut`], and whether the stripped-character cap stopped
    /// its look-back (the stream should then be held whole).
    pub(super) fn release_cut_checked(&self, safe_end: usize) -> (usize, bool) {
        // An unbounded form in the run still open at the scan end: nothing of
        // the run is complete, so it is held whole.
        let cut = if self.run.open_form && self.run.form_start < safe_end {
            self.run.form_start.max(self.base)
        } else {
            safe_end
        };
        // A bounded match still open at the cut starts within the window
        // behind it (the cut, not the scan end: past a pinned form the scan
        // stops at the cut).
        let (window, capped) = self.back_visible_capped(cut, BOUNDED_MATCH_LEN);
        let window = window.max(self.base);
        if capped {
            // Mostly stripped characters behind the cut: an opener before them
            // can still be within the bounded-match lag, so release nothing
            // new until enough visible text follows (or the stream ends).
            return (self.released_end.max(self.base).min(cut), true);
        }
        let end = cut - self.base;
        // A token reaching further back than the padding reach cannot open
        // a bounded match still open at the cut: judge only its tail.
        let window = (window - self.base).min(end);
        let mut index = self.token_start(window, window.saturating_sub(PADDING_REACH));
        debug_assert!(self.text.is_char_boundary(end));
        // Whether the character at `index` (before `end`, so whole) is a
        // boundary (ASCII whitespace or CJK), and its length. Only non-ASCII
        // characters are decoded.
        let boundary_at = |index: usize| match self.text.as_bytes()[index] {
            byte if byte.is_ascii() => (byte.is_ascii_whitespace(), 1),
            _ => self.text[index..]
                .chars()
                .next()
                .map_or((true, 1), |character| {
                    (is_script_boundary(character), character.len_utf8())
                }),
        };
        while index < end {
            let (boundary, length) = boundary_at(index);
            if boundary {
                index += length;
                continue;
            }
            let start = index;
            let mut ascii = true;
            while index < end {
                let (boundary, length) = boundary_at(index);
                if boundary {
                    break;
                }
                ascii &= length == 1;
                index += length;
            }
            let token = &self.text[start..index];
            // Detection matches normalized text, so judge that (an ASCII
            // token is its own normal form).
            let opens = if ascii {
                opens_bounded_match(token)
            } else {
                opens_bounded_match(&ryu_gw_firewall::normalize_for_scan(token))
            };
            if opens {
                return ((self.base + start.max(window)).min(cut), false);
            }
        }
        (cut, false)
    }

    /// The position `count` visible bytes before `position` (never before the
    /// retained text), each character counted by [`scan_width`]: characters
    /// the scan strips (zero-width, soft hyphen, variation selectors) and TAG
    /// characters count for nothing and a folded one (a fullwidth digit) for
    /// its fold, so none of them can stretch a bounded match past the release
    /// lag. Walks at most `count + IGNORABLE_REACH` raw bytes; `true` when
    /// that cap stopped it (the stretch is mostly characters counted as 0).
    pub(super) fn back_visible_capped(&self, position: usize, count: usize) -> (usize, bool) {
        let end = position.saturating_sub(self.base).min(self.text.len());
        // Each trailing ASCII byte is one visible byte, and the cap lies past
        // `count`: count that run in one byte pass, then walk the rest.
        let ascii = self.text.as_bytes()[..end]
            .iter()
            .rev()
            .take(count)
            .take_while(|byte| byte.is_ascii())
            .count();
        if ascii == count {
            return (self.base + end - count, false);
        }
        let mut remaining = count - ascii;
        for (index, character) in self.text[..end - ascii].char_indices().rev() {
            if remaining == 0 {
                return (self.base + index + character.len_utf8(), false);
            }
            if end - index > count + IGNORABLE_REACH {
                return (self.base + index + character.len_utf8(), true);
            }
            remaining = remaining.saturating_sub(scan_width(character));
        }
        (self.base, false)
    }
}

pub(super) use super::carried::keyword_tail;
