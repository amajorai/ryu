import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { type WikiEntry, wikiEntries } from "./wiki-model-pages.ts";
import { wikiThread } from "./wiki-model-routes.ts";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface WikiSearchHit {
	entry: WikiEntry;
	/** Where the match landed: in the title, or only in the body text. */
	inTitle: boolean;
	/** Body text to excerpt in the results list. */
	snippet: string;
}

function normalize(value: string): string {
	return value.toLowerCase().normalize("NFKD");
}

function entryBody(snapshot: InterfaceSnapshot, entry: WikiEntry): string {
	if (entry.kind === "thread") {
		return wikiThread(snapshot, entry.id)?.lastMessage ?? "";
	}
	return entry.description;
}

/**
 * Pages whose title or body contains every word of the query. Title matches
 * come first, then prefix matches, then by recency.
 */
export function wikiSearch(
	snapshot: InterfaceSnapshot,
	query: string
): WikiSearchHit[] {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}
	const hits: (WikiSearchHit & { prefix: boolean })[] = [];
	for (const entry of wikiEntries(snapshot)) {
		const title = normalize(entry.title);
		const body = entryBody(snapshot, entry);
		const haystack = `${title} ${normalize(body)} ${normalize(entry.description)}`;
		if (!words.every((word) => haystack.includes(word))) {
			continue;
		}
		hits.push({
			entry,
			inTitle: words.every((word) => title.includes(word)),
			prefix: title.startsWith(words[0] ?? ""),
			snippet: body,
		});
	}
	hits.sort(
		(a, b) =>
			Number(b.inTitle) - Number(a.inTitle) ||
			Number(b.prefix) - Number(a.prefix) ||
			(b.entry.updatedAt ?? "").localeCompare(a.entry.updatedAt ?? "") ||
			a.entry.title.localeCompare(b.entry.title)
	);
	return hits.map(({ prefix: _prefix, ...hit }) => hit);
}

/**
 * Typeahead suggestions, like the reference's prefix search: every query word
 * must start a word of the title. Title starts rank first, then recency.
 */
export function wikiSuggest(
	snapshot: InterfaceSnapshot,
	query: string,
	limit = 6
): WikiEntry[] {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}
	const scored: { entry: WikiEntry; start: boolean }[] = [];
	for (const entry of wikiEntries(snapshot)) {
		const title = normalize(entry.title);
		const titleWords = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
		if (
			!words.every((word) =>
				titleWords.some((titleWord) => titleWord.startsWith(word))
			)
		) {
			continue;
		}
		scored.push({ entry, start: title.startsWith(words[0] ?? "") });
	}
	scored.sort(
		(a, b) =>
			Number(b.start) - Number(a.start) ||
			(b.entry.updatedAt ?? "").localeCompare(a.entry.updatedAt ?? "") ||
			a.entry.title.localeCompare(b.entry.title)
	);
	return scored.slice(0, limit).map((item) => item.entry);
}

export interface WikiMark {
	match: boolean;
	text: string;
}

/** Split text into runs that do and do not match any query word. */
export function markMatches(value: string, query: string): WikiMark[] {
	const words = query
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (words.length === 0 || !value) {
		return [{ match: false, text: value }];
	}
	const pattern = new RegExp(`(${words.join("|")})`, "gi");
	const marks: WikiMark[] = [];
	let cursor = 0;
	for (const found of value.matchAll(pattern)) {
		const start = found.index ?? 0;
		if (start > cursor) {
			marks.push({ match: false, text: value.slice(cursor, start) });
		}
		marks.push({ match: true, text: found[0] });
		cursor = start + found[0].length;
	}
	if (cursor < value.length) {
		marks.push({ match: false, text: value.slice(cursor) });
	}
	return marks;
}

/** Trim a body around the first match, with ellipses where it was cut. */
export function excerptAround(
	value: string,
	query: string,
	radius = 90
): string {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	const lower = normalize(value);
	let index = -1;
	for (const word of words) {
		const found = lower.indexOf(word);
		if (found !== -1 && (index === -1 || found < index)) {
			index = found;
		}
	}
	if (index === -1 || value.length <= radius * 2) {
		return value.length > radius * 2
			? `${value.slice(0, radius * 2).trimEnd()}…`
			: value;
	}
	const start = Math.max(0, index - radius);
	const end = Math.min(value.length, index + radius);
	return `${start > 0 ? "…" : ""}${value.slice(start, end).trim()}${end < value.length ? "…" : ""}`;
}
