//! Boundary sentinels and the verified split of a marked region: the
//! private-use characters that mark kept bounds, and the check that the
//! marked transform reproduces the unmarked one exactly.

use std::cell::{OnceCell, RefCell};
use std::collections::HashSet;
use std::ops::Range;

use super::Transform;

/// Private-use ranges used as boundary sentinels: the BMP block, then planes
/// 15 and 16, so a long buffered stream still gets one sentinel per frame.
const SENTINEL_RANGES: [(u32, u32); 3] = [
    (0xE000, 0xF8FF),
    (0xF_0000, 0xF_FFFD),
    (0x10_0000, 0x10_FFFD),
];
/// Sentinels available across [`SENTINEL_RANGES`].
pub(super) const SENTINEL_COUNT: usize = 0x1900 + 0xFFFE + 0xFFFE;
/// UTF-8 lead byte of U+E000. Every byte below it is ASCII, a continuation
/// byte or the lead of a character below U+E000; every byte at or above it
/// leads a character at or above U+E000.
const HIGH_LEAD: u8 = 0xEE;
/// Marked transforms one region's splits keep (no eviction past it).
const MAX_MARKED: usize = 16;

pub(super) fn is_sentinel(character: char) -> bool {
    let code = u32::from(character);
    SENTINEL_RANGES
        .iter()
        .any(|(start, end)| (*start..=*end).contains(&code))
}

/// The sentinel for boundary `index` (`index < SENTINEL_COUNT`).
pub(super) fn sentinel(index: usize) -> char {
    let mut rest = u32::try_from(index).unwrap_or(u32::MAX);
    for (start, end) in SENTINEL_RANGES {
        let size = end - start + 1;
        if rest < size {
            return char::from_u32(start + rest).unwrap_or('\u{E000}');
        }
        rest -= size;
    }
    '\u{E000}'
}

/// Values one region's splits share; valid for this region and transform only.
pub(in crate::pipeline::stream_dlp) struct RegionCache<'w> {
    /// `T(region)`.
    pub(super) whole: &'w OnceCell<String>,
    /// `replaced_spans(region, whole)`.
    pub(super) spans: OnceCell<Option<Vec<(usize, usize)>>>,
    /// The sentinels already in the region.
    pub(super) present: OnceCell<HashSet<char>>,
    /// `T(marked)` by the marks `(bound, alphabet index)` of the marked text.
    marked: RefCell<Vec<(Vec<(usize, usize)>, String)>>,
}

impl<'w> RegionCache<'w> {
    pub(in crate::pipeline::stream_dlp) fn new(whole: &'w OnceCell<String>) -> Self {
        Self {
            whole,
            spans: OnceCell::new(),
            present: OnceCell::new(),
            marked: RefCell::new(Vec::new()),
        }
    }
}

/// The characters of `text` at or above U+E000, with their offsets; only
/// those are decoded (see [`HIGH_LEAD`]).
fn high_chars(text: &str) -> impl Iterator<Item = (usize, char)> + '_ {
    let bytes = text.as_bytes();
    let mut at = 0;
    std::iter::from_fn(move || {
        at += bytes[at..].iter().position(|byte| *byte >= HIGH_LEAD)?;
        let character = text[at..].chars().next()?;
        let start = at;
        at += character.len_utf8();
        Some((start, character))
    })
}

/// The sentinels in `region` (what `chars().filter(is_sentinel)` finds).
pub(in crate::pipeline::stream_dlp) fn sentinels_in(region: &str) -> HashSet<char> {
    high_chars(region)
        .map(|(_, character)| character)
        .filter(|character| is_sentinel(*character))
        .collect()
}

/// Mark the kept boundaries, transform, and accept only an exact split.
pub(super) fn verified_split(
    region: &str,
    local: &[usize],
    keep: &[bool],
    whole: &str,
    transform: &Transform<'_>,
    alphabet: &[char],
    cache: &RegionCache<'_>,
) -> Option<Vec<String>> {
    // A bound at the region end splits nothing, and a match running to the
    // end (`[^&\s"']{4,}`) would take its sentinel in.
    let marks: Vec<(usize, usize)> = local
        .iter()
        .enumerate()
        .filter(|(index, bound)| keep[*index] && **bound != region.len())
        .map(|(index, bound)| (*bound, index))
        .collect();
    // The marks fix the marked text: `alphabet[i]` is the i-th sentinel the
    // region does not hold, whatever the alphabet's length.
    if let Some((_, output)) = cache
        .marked
        .borrow()
        .iter()
        .find(|(seen, _)| *seen == marks)
    {
        debug_assert_eq!(*output, transform.apply(&mark(region, &marks, alphabet)));
        return verify(output, &marks, keep, whole, alphabet, local.len());
    }
    let output = transform.apply(&mark(region, &marks, alphabet));
    let found = verify(&output, &marks, keep, whole, alphabet, local.len());
    let mut memo = cache.marked.borrow_mut();
    if memo.len() < MAX_MARKED {
        memo.push((marks, output));
    }
    found
}

/// `region` with `alphabet[index]` inserted at each `(bound, index)` mark.
fn mark(region: &str, marks: &[(usize, usize)], alphabet: &[char]) -> String {
    let mut marked = String::with_capacity(region.len() + marks.len() * 4);
    let mut cursor = 0;
    for (bound, index) in marks {
        marked.push_str(&region[cursor..*bound]);
        marked.push(alphabet[*index]);
        cursor = *bound;
    }
    marked.push_str(&region[cursor..]);
    marked
}

/// The segments of `output`, the transform of the region marked at `marks`,
/// when its kept sentinels are exactly the marks, in order, and the text
/// between them is `whole`. The alphabet ascends, so a binary search finds a
/// sentinel's index.
pub(in crate::pipeline::stream_dlp) fn verify(
    output: &str,
    marks: &[(usize, usize)],
    keep: &[bool],
    whole: &str,
    alphabet: &[char],
    bound_count: usize,
) -> Option<Vec<String>> {
    debug_assert!(alphabet.windows(2).all(|pair| pair[0] < pair[1]));
    let hit = |character: char| {
        alphabet
            .binary_search(&character)
            .ok()
            .filter(|index| keep.get(*index).copied().unwrap_or(false))
    };
    let (seen, ranges) = split_marked_ranges(output, hit, marks.len());
    if !seen
        .iter()
        .copied()
        .eq(marks.iter().map(|(_, index)| *index))
    {
        return None;
    }
    // The pieces join to `whole` exactly when each is its next slice.
    let mut cursor = 0;
    for range in &ranges {
        let piece = &output.as_bytes()[range.clone()];
        if whole.as_bytes().get(cursor..cursor + piece.len()) != Some(piece) {
            return None;
        }
        cursor += piece.len();
    }
    if cursor != whole.len() {
        return None;
    }
    // Range 0 precedes the first kept bound; range k follows kept bound k-1.
    let mut segments = vec![String::new(); bound_count - 1];
    for (position, (_, index)) in marks.iter().enumerate() {
        if *index < segments.len() {
            segments[*index] = output[ranges[position + 1].clone()].to_owned();
        }
    }
    Some(segments)
}

/// The `hit` sentinels found in `output`, in order, and the ranges between
/// them: `ranges[0]` before the first, `ranges[k]` after the k-th. A
/// character below U+E000 is never decoded (see [`HIGH_LEAD`]).
pub(in crate::pipeline::stream_dlp) fn split_marked_ranges(
    output: &str,
    hit: impl Fn(char) -> Option<usize>,
    expected: usize,
) -> (Vec<usize>, Vec<Range<usize>>) {
    let mut ranges = Vec::with_capacity(expected + 1);
    let mut seen = Vec::with_capacity(expected);
    let mut from = 0;
    for (at, character) in high_chars(output) {
        if !is_sentinel(character) {
            continue;
        }
        if let Some(index) = hit(character) {
            seen.push(index);
            ranges.push(from..at);
            from = at + character.len_utf8();
        }
    }
    ranges.push(from..output.len());
    (seen, ranges)
}

/// [`split_marked_ranges`] by a lookup, with owned pieces (tests).
#[cfg(test)]
pub(in crate::pipeline::stream_dlp) fn split_marked(
    output: &str,
    lookup: &std::collections::HashMap<char, usize>,
    expected: usize,
) -> (Vec<usize>, Vec<String>) {
    debug_assert!(lookup.keys().all(|character| is_sentinel(*character)));
    let (seen, ranges) = split_marked_ranges(output, |c| lookup.get(&c).copied(), expected);
    let pieces = ranges
        .into_iter()
        .map(|range| output[range].to_owned())
        .collect();
    (seen, pieces)
}
