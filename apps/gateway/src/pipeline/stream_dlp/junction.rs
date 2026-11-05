//! Where a split may put its sentinel: a non-word private-use character
//! must not add or remove a word boundary a built-in match relies on.

/// Where a split at `at` must start instead so its sentinel (a non-word
/// character) changes no word boundary a match relies on. The built-in
/// patterns use `(?:\b|(?-u:\b))`, so a junction joins (has no boundary a
/// sentinel would add, or has one it would remove) when:
/// - both sides are ASCII word characters: start at that run's start;
/// - a word character comes before `(` or `+` (`话|(555)`, `x|+1`), the only
///   non-word characters a built-in match starts with after a boundary;
/// - both sides are non-ASCII word characters and one is a digit
///   (`は|１２３`): neither boundary holds there in the joined text.
///
/// The split moves back over joining junctions (at most [`JOIN_STEPS`]
/// characters past an ASCII run); otherwise `at` itself.
pub(super) fn word_start(region: &str, at: usize) -> usize {
    let ascii_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let bytes = region.as_bytes();
    let mut start = at;
    for _ in 0..JOIN_STEPS {
        if start == 0 || start >= bytes.len() {
            return start;
        }
        if ascii_word(bytes[start - 1]) && ascii_word(bytes[start]) {
            while start > 0 && ascii_word(bytes[start - 1]) {
                start -= 1;
            }
            continue;
        }
        let (Some(previous), Some(next)) = (
            region[..start].chars().next_back(),
            region[start..].chars().next(),
        ) else {
            return start;
        };
        let joins = (regex_word(previous) && matches!(next, '(' | '+'))
            || (!previous.is_ascii()
                && !next.is_ascii()
                && regex_word(previous)
                && regex_word(next)
                && (previous.is_numeric() || next.is_numeric()))
            // `(?i)` folds the long s and the Kelvin sign to `s` / `k`, which
            // start keyword forms (`secret=`) after a boundary.
            || (!previous.is_ascii()
                && regex_word(previous)
                && matches!(next, '\u{17F}' | '\u{212A}'));
        if !joins {
            return start;
        }
        start -= previous.len_utf8();
    }
    at
}

/// Characters a [`word_start`] walk may step over.
const JOIN_STEPS: usize = 64;

/// A regex `\w` character: alphanumeric, `_`, a combining mark or a joiner.
fn regex_word(character: char) -> bool {
    character.is_alphanumeric()
        || character == '_'
        || matches!(u32::from(character),
            0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF
            | 0xFE20..=0xFE2F | 0x200C | 0x200D)
}
