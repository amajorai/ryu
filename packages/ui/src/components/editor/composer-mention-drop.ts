// Pure spacing rules for dragging a mention chip to a new spot in the composer.
// Kept free of React and Plate so the rules can be unit tested directly.

const TRAILING_WHITESPACE = /\s$/;
const WHITESPACE = /\s/;
const NO_TRAIL_BEFORE = /[\s.,;:!?'")\]]/;

/**
 * Whether removing a chip should also drop the leading space of the text that
 * follows it: the chip was the line's first word or sat between two spaces, so
 * moving it would otherwise strand a double gap.
 */
export function shouldTrimGapAfterRemovedMention(
	previous: string | undefined,
	next: string | undefined,
	position: number
): boolean {
	const leftEdge =
		previous === undefined || (previous === "" && position === 1);
	return (
		next?.startsWith(" ") === true &&
		(leftEdge || TRAILING_WHITESPACE.test(previous ?? ""))
	);
}

/**
 * Spaces to pad a dropped chip with so it stays a whitespace-delimited
 * `@label` once the draft round-trips through Markdown (`a@b` would not parse
 * back).
 */
export function mentionDropPadding({
	before,
	after,
	hasPrevious,
	hasNext,
}: {
	after?: string;
	before?: string;
	hasNext: boolean;
	hasPrevious: boolean;
}): { lead: boolean; trail: boolean } {
	return {
		lead: hasPrevious && !WHITESPACE.test(before ?? ""),
		trail: hasNext && !NO_TRAIL_BEFORE.test(after ?? ""),
	};
}
