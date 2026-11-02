//! Items: segments cut into overlapping, token-bounded chunks, each with the
//! text before it as context (spec 02.5.4).

use ryu_gw_screening::{LeafClass, ScreenItem, SegmentKey};

use super::{ScreenInput, CHUNK_CHARS, CHUNK_TOKENS, CONTEXT_CHARS, CONTEXT_TOKENS, OVERLAP_CHARS};

/// Split segments into items of at most [`CHUNK_CHARS`] and [`CHUNK_TOKENS`],
/// overlapping by [`OVERLAP_CHARS`], each with up to [`CONTEXT_CHARS`] of the
/// text before it. Consecutive segments of the same class share an item
/// (many small tool definitions are one item, not one call each); a class
/// change starts a new item.
pub(super) fn items_for(scope: &[u8], input: &ScreenInput) -> Vec<ScreenItem> {
    items_within(scope, input, CHUNK_TOKENS)
}

/// The smallest item budget a role's chunks are cut to. Below it a backend
/// that declares a tinier limit leaves items undecided, which the fail rules
/// and the degraded marker report, rather than multiplying the calls.
pub(super) const MIN_ROLE_CHUNK_TOKENS: u32 = CHUNK_TOKENS / 4;

/// The items for a role whose backends accept at most `budget` estimated
/// tokens per item. Items that already fit are the hazard role's own (so a
/// backend serving both roles answers from the cache); only when one does
/// not are the segments cut again to the budget, so no item is skipped by
/// the chain as too large and left unread (the inspector reads 1,024).
pub(super) fn items_for_budget(
    scope: &[u8],
    input: &ScreenInput,
    items: &[ScreenItem],
    budget: u32,
) -> Vec<ScreenItem> {
    let budget = budget.clamp(MIN_ROLE_CHUNK_TOKENS, CHUNK_TOKENS);
    let fits = items.iter().all(|item| {
        item.text
            .as_deref()
            .is_none_or(|text| ryu_gw_screening::estimate_tokens(text) <= budget)
    });
    if fits {
        items.to_vec()
    } else {
        items_within(scope, input, budget)
    }
}

fn items_within(scope: &[u8], input: &ScreenInput, chunk_tokens: u32) -> Vec<ScreenItem> {
    let mut runs: Vec<(LeafClass, String)> = Vec::new();
    for segment in &input.segments {
        match runs.last_mut() {
            Some((class, text))
                if *class == segment.class
                    && text.chars().count() + segment.text.chars().count() < CHUNK_CHARS =>
            {
                text.push('\n');
                text.push_str(&segment.text);
            }
            _ => runs.push((segment.class, segment.text.clone())),
        }
    }
    let mut items = Vec::new();
    let mut prior = String::new();
    for (class, run) in &runs {
        let chars: Vec<char> = run.chars().collect();
        let mut start = 0;
        loop {
            let end = chunk_end(&chars, start, chunk_tokens);
            let last = end == chars.len();
            // The overlap is at most a quarter of the chunk: a role cut to a
            // small budget (dense text at 512 tokens is 512 chars, the whole
            // overlap) would otherwise step one character at a time and turn
            // one prompt into an item per character.
            let overlap = OVERLAP_CHARS.min((end - start) / 4);
            let step = (end - start - overlap).max(1);
            let text: String = chars[start..end].iter().collect();
            let context = (!prior.is_empty()).then(|| {
                let from = prior
                    .char_indices()
                    .rev()
                    .nth(CONTEXT_CHARS.saturating_sub(1))
                    .map_or(0, |(i, _)| i);
                ryu_gw_screening::context_tail(&prior[from..], CONTEXT_TOKENS)
            });
            let context = context.filter(|c| !c.is_empty());
            // Definitions are tenant-authored schemas shared across requests,
            // so a definition read on its own is keyed in a global scope (spec
            // 02.8). Once it carries an org's conversation as context its
            // score is no longer a property of the definition alone, so it is
            // keyed in the org scope: a score one org's context produced never
            // decides another org's request.
            let key_scope: &[u8] = if *class == LeafClass::Definition && context.is_none() {
                b"definition"
            } else {
                scope
            };
            // The key binds the context the item is classified with, so a
            // segment cached on its own is classified again beside a new
            // prefix (spec 02.8, combination verdict).
            let key = SegmentKey::for_text_in_context(key_scope, *class, &text, context);
            let mut item = ScreenItem::text(key, *class, text.as_str());
            if let Some(context) = context {
                item = item.with_context(context);
            }
            items.push(item);
            // The context of the next chunk is the text before its start, so
            // the overlap is never read twice.
            if last {
                prior.push_str(&text);
                prior.push('\n');
            } else {
                prior.extend(&chars[start..start + step]);
            }
            if prior.len() > CONTEXT_CHARS * 2 {
                let cut = prior.len() - CONTEXT_CHARS;
                let cut = (cut..prior.len())
                    .find(|i| prior.is_char_boundary(*i))
                    .unwrap_or(prior.len());
                prior.drain(..cut);
            }
            if last {
                break;
            }
            start += step;
        }
    }
    items
}

/// Where the chunk that starts at `start` ends: at most [`CHUNK_CHARS`]
/// characters and at most `chunk_tokens` estimated tokens.
fn chunk_end(chars: &[char], start: usize, chunk_tokens: u32) -> usize {
    let mut end = (start + CHUNK_CHARS).min(chars.len());
    loop {
        let tokens = ryu_gw_screening::estimate_tokens_chars(chars[start..end].iter().copied());
        let len = end - start;
        if tokens <= chunk_tokens || len <= 1 {
            return end;
        }
        // Keep the share of the chunk the budget allows, at least one fewer
        // character than now, so every pass shrinks and the loop ends.
        let keep = (len as u64 * u64::from(chunk_tokens) / u64::from(tokens)) as usize;
        end = start + keep.clamp(1, len - 1);
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::*;
    use ryu_gw_screening::estimate_tokens;

    fn input(text: &str) -> ScreenInput {
        let mut input = ScreenInput::default();
        input.push(LeafClass::User, text);
        input
    }

    /// Token-dense text is cut by estimated tokens, not only by characters, so
    /// no item outruns the engine context; every marker stays whole in some
    /// item, and each item's context stays inside its own budget.
    #[test]
    fn token_dense_text_is_split_to_the_token_budget_without_losing_text() {
        let mut chars: Vec<char> = "\u{754c}".repeat(10_000).chars().collect();
        let markers = [
            ("M0", 0),
            ("M1", 2_040),
            ("M2", 2_047),
            ("M3", 5_000),
            ("M4", 9_990),
        ];
        for (marker, at) in markers {
            for (offset, c) in marker.chars().enumerate() {
                chars[at + offset] = c;
            }
        }
        let text: String = chars.into_iter().collect();
        let items = items_for(&[7; 32], &input(&text));
        assert!(items.len() >= 5, "{}", items.len());
        for item in &items {
            let body = item.text.as_deref().expect("text item");
            assert!(
                estimate_tokens(body) <= CHUNK_TOKENS,
                "{}",
                estimate_tokens(body)
            );
            if let Some(context) = item.context.as_deref() {
                assert!(estimate_tokens(context) <= CONTEXT_TOKENS);
            }
        }
        for (marker, _) in markers {
            assert!(
                items
                    .iter()
                    .any(|i| i.text.as_deref().is_some_and(|t| t.contains(marker))),
                "{marker} is whole in no item"
            );
        }
    }

    /// Prose stays at the character chunk size, so ordinary traffic costs no
    /// extra classifier calls.
    #[test]
    fn prose_keeps_the_character_chunk_size() {
        let prose = "the quick brown fox jumps over the lazy dog ".repeat(450);
        let items = items_for(&[7; 32], &input(&prose));
        let first = items[0].text.as_deref().expect("text item");
        assert_eq!(first.chars().count(), CHUNK_CHARS);
    }

    /// A role whose backend reads fewer tokens gets every item cut to its
    /// budget, so nothing is left unread; short text keeps the hazard
    /// role's own items (cache hits for a backend serving both).
    #[test]
    fn a_smaller_role_budget_recuts_only_when_an_item_does_not_fit() {
        let prose = "the quick brown fox jumps over the lazy dog ".repeat(450);
        let hazard = items_for(&[7; 32], &input(&prose));
        let attack = items_for_budget(&[7; 32], &input(&prose), &hazard, 1_024);
        assert!(attack.len() > hazard.len());
        for item in &attack {
            assert!(estimate_tokens(item.text.as_deref().expect("text")) <= 1_024);
        }
        let short = items_for(&[7; 32], &input("short prompt"));
        let same = items_for_budget(&[7; 32], &input("short prompt"), &short, 1_024);
        assert_eq!(same[0].key, short[0].key);
        let floor = items_for_budget(&[7; 32], &input(&prose), &hazard, 1);
        for item in &floor {
            let tokens = estimate_tokens(item.text.as_deref().expect("text"));
            assert!(tokens <= MIN_ROLE_CHUNK_TOKENS, "{tokens}");
        }
    }

    /// Dense text cut to the smallest role budget still advances by most of
    /// a chunk: the item count grows with the text, not one per character.
    #[test]
    fn the_smallest_role_budget_keeps_the_item_count_linear() {
        let dense = "\u{754c}".repeat(20_000);
        let hazard = items_for(&[7; 32], &input(&dense));
        let attack = items_for_budget(&[7; 32], &input(&dense), &hazard, 1);
        let budget = MIN_ROLE_CHUNK_TOKENS as usize;
        assert!(
            attack.len() <= 20_000 / (budget * 3 / 4) + 1,
            "{} items",
            attack.len()
        );
        // Still nothing unread: consecutive items overlap.
        let mut covered = 0;
        for item in &attack {
            covered += item.text.as_deref().expect("text").chars().count();
        }
        assert!(covered >= 20_000);
        // The hazard role's own items are unchanged by the bound.
        assert!(hazard.len() <= 20_000 / (CHUNK_TOKENS as usize - OVERLAP_CHARS) + 1);
    }
}
