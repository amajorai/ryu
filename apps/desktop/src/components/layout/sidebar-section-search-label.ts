import type { LiteralMessage } from "@ryu/i18n/react";

// The overflow popover's search field names its section in one whole
// sentence ("Search chats"), never "Search {section}" around a bare noun: a
// one-word plural key also serves "{n} tools" sites, so its translation can
// be a counter fragment (ko "개 도구"), and several section nouns had no
// catalog entry at all. Keyed by the English `overflow.label` each sidebar
// section passes; each value is an explicit `tl()` call so the extractor
// collects the sentence.
const SEARCH_LABELS: Readonly<Record<string, (tl: LiteralMessage) => string>> =
	{
		agents: (tl) => tl("Search agents"),
		"archived chats": (tl) => tl("Search archived chats"),
		channels: (tl) => tl("Search channels"),
		chats: (tl) => tl("Search chats"),
		engines: (tl) => tl("Search engines"),
		"group threads": (tl) => tl("Search group threads"),
		identities: (tl) => tl("Search identities"),
		integrations: (tl) => tl("Search integrations"),
		"MCP servers": (tl) => tl("Search MCP servers"),
		pages: (tl) => tl("Search pages"),
		"pinned chats": (tl) => tl("Search pinned chats"),
		plugins: (tl) => tl("Search plugins"),
		projects: (tl) => tl("Search projects"),
		skills: (tl) => tl("Search skills"),
		threads: (tl) => tl("Search threads"),
		tools: (tl) => tl("Search tools"),
	};

/**
 * The whole translated search sentence for a sidebar section, or
 * `fallback()` (the generic "Search {section}" message) for a label this
 * table does not know yet.
 */
export function searchLabelFor(
	label: string,
	tl: LiteralMessage,
	fallback: () => string
): string {
	const sentence = Object.hasOwn(SEARCH_LABELS, label)
		? SEARCH_LABELS[label]
		: undefined;
	return sentence ? sentence(tl) : fallback();
}
