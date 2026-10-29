// Command-palette ranking. Pure and dependency-free so it can be unit-tested
// without a renderer. Each entry is scored over its label and aliases, keeping
// the best tier:
//
//   exact (4) > prefix (3) > word-prefix (2) > substring (1.5) > subsequence (1)
//
// Word-prefix means every query token prefixes a successive word ("new ch" ->
// "New chat"). Substring and subsequence also compare with spaces removed, so
// "gotohome" finds "Go to Home" and "nwcht" finds "New chat". A subsequence gets
// a small bonus for compact matches, and recently used ids a smaller one; both
// stay below the next tier so a tier is never interleaved. The sort is stable:
// entries in the same tier keep their declaration order.

export interface RankableEntry {
	aliases?: string[];
	id: string;
	label: string;
}

const TIER_EXACT = 4;
const TIER_PREFIX = 3;
const TIER_WORD_PREFIX = 2;
const TIER_SUBSTRING = 1.5;
const TIER_SUBSEQUENCE = 1;
const SUBSEQUENCE_COMPACTNESS_BONUS = 0.3;
const RECENT_BOOST = 0.1;

const WHITESPACE = /\s+/g;
const WORD_SPLIT = /[^a-z0-9]+/;

/** Lowercase and collapse runs of whitespace (keeps inner single spaces). */
export function normalisePaletteQuery(query: string): string {
	return query.toLowerCase().replace(WHITESPACE, " ").trim();
}

function compact(text: string): string {
	return text.replace(WHITESPACE, "");
}

function matchesWordPrefixes(tokens: string[], words: string[]): boolean {
	let wordIndex = 0;
	for (const token of tokens) {
		while (wordIndex < words.length && !words[wordIndex]?.startsWith(token)) {
			wordIndex += 1;
		}
		if (wordIndex >= words.length) {
			return false;
		}
		wordIndex += 1;
	}
	return true;
}

/** Span of the leftmost-greedy subsequence match, or -1 when absent. */
function subsequenceSpan(needle: string, haystack: string): number {
	let start = -1;
	let position = 0;
	for (const character of needle) {
		const found = haystack.indexOf(character, position);
		if (found === -1) {
			return -1;
		}
		if (start === -1) {
			start = found;
		}
		position = found + 1;
	}
	return position - start;
}

function scoreText(query: string, rawText: string): number {
	const text = normalisePaletteQuery(rawText);
	if (text === query) {
		return TIER_EXACT;
	}
	if (text.startsWith(query)) {
		return TIER_PREFIX;
	}
	const words = text.split(WORD_SPLIT).filter((word) => word.length > 0);
	const tokens = query.split(WORD_SPLIT).filter((token) => token.length > 0);
	if (tokens.length > 0 && matchesWordPrefixes(tokens, words)) {
		return TIER_WORD_PREFIX;
	}
	const compactQuery = compact(query);
	const compactText = compact(text);
	if (text.includes(query) || compactText.includes(compactQuery)) {
		return TIER_SUBSTRING;
	}
	const span = subsequenceSpan(compactQuery, compactText);
	if (span > 0) {
		return (
			TIER_SUBSEQUENCE +
			SUBSEQUENCE_COMPACTNESS_BONUS * (compactQuery.length / span)
		);
	}
	return 0;
}

/** Score one entry against an already-normalised query (0 = no match). */
export function scorePaletteEntry(entry: RankableEntry, query: string): number {
	let best = 0;
	for (const text of [entry.label, ...(entry.aliases ?? [])]) {
		best = Math.max(best, scoreText(query, text));
	}
	return best;
}

/**
 * Filter and rank palette entries for `query`. An empty query returns the
 * entries unchanged. Ids in `recent` get a boost smaller than one tier.
 */
export function rankPaletteEntries<T extends RankableEntry>(
	entries: readonly T[],
	query: string,
	recent: readonly string[] = []
): T[] {
	const normalised = normalisePaletteQuery(query);
	if (normalised.length === 0) {
		return [...entries];
	}
	const recentIds = new Set(recent);
	const scored: { entry: T; order: number; score: number }[] = [];
	for (const [order, entry] of entries.entries()) {
		const score = scorePaletteEntry(entry, normalised);
		if (score > 0) {
			scored.push({
				entry,
				order,
				score: score + (recentIds.has(entry.id) ? RECENT_BOOST : 0),
			});
		}
	}
	scored.sort((a, b) => b.score - a.score || a.order - b.order);
	return scored.map((item) => item.entry);
}
