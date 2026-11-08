import type { MessageValuesInput } from "@ryu/i18n/core";
import type { VisualBlock } from "./blocks.ts";

// The editor imports both from here, so its import stays one line.
// biome-ignore lint/performance/noBarrelFile: one re-export keeps the 500-line editor line-neutral.
export { visualBlock } from "./blocks.ts";

/** Translator shape: `useLiteralMessages()` in React. */
export type BlockLiteral = (
	source: string,
	values?: MessageValuesInput
) => string;

/**
 * Placeholder copy a palette block inserts into the user's page, paired with
 * its translation. Each source is a literal `tl()` call so the extractor puts
 * it in the Sites and App Studio catalogs. The copy is inserted once, in the
 * language the editor shows, and then belongs to the page like typed text.
 */
function blockCopy(tl: BlockLiteral): readonly (readonly [string, string])[] {
	return [
		["New section", tl("New section")],
		["Describe this part of the page.", tl("Describe this part of the page.")],
		["Heading", tl("Heading")],
		[
			"Write something people will want to read.",
			tl("Write something people will want to read."),
		],
		["Get started", tl("Get started")],
		["Describe this image", tl("Describe this image")],
		["First column", tl("First column")],
		["Second column", tl("Second column")],
		["Supporting text.", tl("Supporting text.")],
		["Feature one", tl("Feature one")],
		["Feature two", tl("Feature two")],
		["Feature three", tl("Feature three")],
		["Why it matters.", tl("Why it matters.")],
		["First point", tl("First point")],
		["Second point", tl("Second point")],
		["Third point", tl("Third point")],
		// The quotation marks are part of the message so each language can use
		// its own (「」, « », „“).
		["“A quote that builds trust.”", tl("“A quote that builds trust.”")],
	];
}

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * The block's HTML with its placeholder text and alt text in the editor's
 * language. Translations are HTML-escaped before they are spliced in, so a
 * catalog entry cannot inject markup into the user's page.
 */
export function blockHtml(block: VisualBlock, tl: BlockLiteral): string {
	const translations = new Map<string, string>();
	for (const [source, translated] of blockCopy(tl)) {
		if (translated !== source) {
			translations.set(source, escapeHtml(translated));
		}
	}
	if (translations.size === 0) {
		return block.html;
	}
	// One pass over text nodes and alt attributes, so a translation that
	// happens to equal another English source is never translated twice.
	return block.html.replace(
		/>([^<]+)<|alt="([^"]*)"/g,
		(match, text?: string, alt?: string) => {
			if (text !== undefined) {
				const safe = translations.get(text);
				return safe === undefined ? match : `>${safe}<`;
			}
			const safe = alt === undefined ? undefined : translations.get(alt);
			return safe === undefined ? match : `alt="${safe}"`;
		}
	);
}
