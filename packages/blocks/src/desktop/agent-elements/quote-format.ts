/**
 * Pure, dependency-free helpers for chat message quoting. Kept separate from
 * `quote.tsx` (which pulls in React / UI deps) so the encode/decode logic — the
 * load-bearing persistence contract — is unit-testable in isolation.
 */

/** Elements whose text can be quoted carry this attribute; the selection
 * toolbar only appears when a selection sits fully inside one. */
export const SELECTABLE_ATTR = "data-message-selectable";

/** Marks a container's text as quotable. Spread onto message text wrappers. */
export const messageSelectableProps = { [SELECTABLE_ATTR]: "" } as const;

/**
 * Encode a selection as a leading markdown blockquote to prepend to an outgoing
 * message. Each line is `> `-prefixed (blank lines become a bare `>`), followed
 * by a blank separator line before the user's own text.
 */
export function formatQuotePrefix(quote: string): string {
	const block = quote
		.split("\n")
		.map((line) => (line.trim() ? `> ${line}` : ">"))
		.join("\n");
	return `${block}\n\n`;
}

/**
 * Peel a leading run of markdown `>` blockquote lines off a message body,
 * returning the un-prefixed quote text and the remaining body. Used to render a
 * styled quote block above a user bubble that was sent with a quote.
 */
export function splitLeadingQuote(text: string): {
	quote: string | null;
	body: string;
} {
	const lines = text.split("\n");
	const quoteLines: string[] = [];
	let i = 0;
	while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
		quoteLines.push((lines[i] ?? "").replace(/^>\s?/, ""));
		i += 1;
	}
	if (quoteLines.length === 0) {
		return { quote: null, body: text };
	}
	// Drop the blank separator line(s) between the quote and the body.
	while (i < lines.length && (lines[i] ?? "").trim() === "") {
		i += 1;
	}
	return {
		quote: quoteLines.join("\n").trim(),
		body: lines.slice(i).join("\n"),
	};
}
