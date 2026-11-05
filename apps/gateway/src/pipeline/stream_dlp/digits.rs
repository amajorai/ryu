//! Group chains: runs of digits and capital letters joined by single
//! separators, a space, dash, dot or other ASCII whitespace (`4111 1111 1111
//! 1111`, `RO49 AAAA 1B31 ...`, numbers one per line). The card and
//! IBAN forms take a bounded number of groups from such a chain, starting
//! where leftmost-first matching starts them, so which groups form a
//! candidate depends on where the chain begins. A scan must therefore
//! begin a chain where a scan of the whole text begins it, and must not end
//! inside one that is still growing.

/// How far behind a position the scan start may reach to start a chain where
/// a scan of the whole text starts it. A stream whose chain grows longer is
/// held whole (`track_run`), so no scan has to cut into it.
pub(super) const DIGIT_RUN_REACH: usize = 16 * 1024;

/// A character's part in a chain, judged as the scan normalizes it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Digit,
    Letter,
    /// A space, dash, dot or other ASCII whitespace: one may sit between
    /// two groups.
    Separator,
    /// Stripped by the scan (zero-width and similar).
    Ignorable,
    Other,
}

fn class(character: char) -> Class {
    if character.is_ascii() {
        return match character {
            '0'..='9' => Class::Digit,
            'A'..='Z' => Class::Letter,
            // Every separator a group form accepts (`[-.\s]` for phones).
            ' ' | '-' | '.' | '\t' | '\n' | '\r' | '\x0c' => Class::Separator,
            _ => Class::Other,
        };
    }
    if character.is_numeric() {
        return Class::Digit;
    }
    let mut buffer = [0u8; 4];
    let normalized = ryu_gw_firewall::normalize_for_scan(character.encode_utf8(&mut buffer));
    match normalized.chars().next() {
        None => Class::Ignorable,
        Some(' ' | '-' | '.') => Class::Separator,
        Some('A'..='Z') => Class::Letter,
        Some(folded) if folded.is_numeric() => Class::Digit,
        Some(_) => Class::Other,
    }
}

/// Whether the scan strips `character` (zero-width and similar).
pub(super) fn is_ignorable(character: char) -> bool {
    !character.is_ascii() && class(character) == Class::Ignorable
}

fn in_group(class: Class) -> bool {
    matches!(class, Class::Digit | Class::Letter)
}

/// The chain the text received so far ends in.
#[derive(Default, Clone, Copy)]
pub(super) struct Chain {
    /// Bytes of the chain, including a trailing separator.
    pub(super) length: usize,
    separated: bool,
    has_digit: bool,
}

impl Chain {
    pub(super) fn extend(&mut self, text: &str) {
        for character in text.chars() {
            let width = character.len_utf8();
            match class(character) {
                Class::Digit | Class::Letter => {
                    self.length += width;
                    self.separated = false;
                    self.has_digit |= class(character) == Class::Digit;
                }
                Class::Separator if self.length > 0 && !self.separated => {
                    self.length += width;
                    self.separated = true;
                }
                Class::Ignorable if self.length > 0 => self.length += width,
                Class::Ignorable => {}
                Class::Separator | Class::Other => *self = Self::default(),
            }
        }
    }

    /// A chain that can hold a card or IBAN candidate and may still grow.
    pub(super) fn open(&self) -> bool {
        self.length > 0 && self.has_digit
    }
}

/// The start of the chain that `text[index..]` begins in or continues, not
/// before `floor`, and whether the walk stopped at `floor` still inside the
/// chain (the chain reaches further back than the scan may).
///
/// Only groups with a digit can start a card or IBAN candidate, so the
/// start is the first such group of the chain; a chain part of letters
/// alone (capitalized words) does not move the start.
pub(super) fn chain_start(text: &str, index: usize, floor: usize) -> (usize, bool) {
    let (start, cut) = walk_back(text, index, floor);
    match first_digit_group(text, start, index) {
        Some(group) if group < index => (group, cut),
        _ => (index, false),
    }
}

fn walk_back(text: &str, mut index: usize, floor: usize) -> (usize, bool) {
    let mut next_in_group = text[index..]
        .chars()
        .map(class)
        .find(|class| *class != Class::Ignorable)
        .is_some_and(in_group);
    while let Some(previous) = text[..index].chars().next_back() {
        let continues = match class(previous) {
            Class::Digit | Class::Letter | Class::Ignorable => true,
            Class::Separator => next_in_group,
            Class::Other => false,
        };
        if !continues {
            return (index, false);
        }
        if index <= floor {
            return (index, true);
        }
        match class(previous) {
            Class::Separator => next_in_group = false,
            Class::Ignorable => {}
            _ => next_in_group = true,
        }
        index -= previous.len_utf8();
    }
    (index, false)
}

/// The start of the first group with a digit in the chain from `start`,
/// looking up to the end of the group holding `until`.
fn first_digit_group(text: &str, start: usize, until: usize) -> Option<usize> {
    let mut group = start;
    let mut digit = false;
    // A group starting at or after `until` cannot be the answer
    // (`chain_start` keeps only earlier ones), and the group holding `until`
    // is looked at for at most the reach.
    let limit = until.saturating_add(DIGIT_RUN_REACH);
    for (offset, character) in text[start..].char_indices() {
        let at = start + offset;
        if (!digit && group >= until) || at >= limit {
            return digit.then_some(group);
        }
        match class(character) {
            Class::Digit => digit = true,
            Class::Letter | Class::Ignorable => {}
            Class::Separator | Class::Other => {
                if digit {
                    return Some(group);
                }
                if at >= until || class(character) == Class::Other {
                    return None;
                }
                group = at + character.len_utf8();
            }
        }
    }
    digit.then_some(group)
}

/// The end of the chain running on from `from`: the first character no
/// group takes, or the second of two separators in a row.
pub(super) fn chain_end(text: &str, from: usize) -> usize {
    let mut separated = false;
    for (offset, character) in text[from..].char_indices() {
        match class(character) {
            Class::Digit | Class::Letter => separated = false,
            Class::Separator if !separated => separated = true,
            Class::Ignorable => {}
            Class::Separator | Class::Other => return from + offset,
        }
    }
    text.len()
}

impl super::StreamingDlp {
    /// `cut` and `scan_end` held back to the start of a group chain the scan
    /// end would cut into: one still growing at the end of the text, or one
    /// running on past `safe_end` (closed by punctuation glued to its last
    /// group). The release cut also stays behind any bounded match that
    /// could run from before the chain into it.
    pub(super) fn before_open_chain(
        &mut self,
        final_step: bool,
        safe_end: usize,
        detect_from: usize,
        cut: usize,
        scan_end: usize,
    ) -> (usize, usize) {
        if final_step {
            return (cut, scan_end);
        }
        let current = self
            .len()
            .saturating_sub(self.run.chain.length)
            .max(self.base);
        let start = if self.run.chain.length > 0 && current < safe_end {
            // The chain the text ends in crosses the scan end; without a
            // digit it can hold no candidate (and no other chain can).
            self.run.chain.open().then_some(current)
        } else if safe_end == self.last_space && !self.run.visible_after_space {
            // Only zero-width characters after the scan end: no chain runs on
            // past it (and the walk would rescan them on every push).
            None
        } else {
            let index = safe_end.saturating_sub(self.base);
            let floor = index.saturating_sub(DIGIT_RUN_REACH);
            let (start, _) = chain_start(&self.text, index, floor);
            (start < index).then_some(self.base + start)
        };
        let Some(start) = start else {
            return (cut, scan_end);
        };
        let key = (self.base, start, self.run.open_form, self.run.form_start);
        let (token, release) = match self.run.hold_memo {
            Some((memo, hold)) if memo == key => hold,
            _ => {
                let token = self.base + self.token_start(start - self.base, 0);
                let hold = (token, self.release_cut(token));
                self.run.hold_memo = Some((key, hold));
                hold
            }
        };
        (
            cut.min(token).min(release),
            scan_end.min(token.max(detect_from)),
        )
    }
}
