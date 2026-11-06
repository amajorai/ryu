import type { LiteralMessage } from "@ryu/i18n";

/**
 * The exact English title older clients and Core stored for a document that
 * had no name. New Space pages, databases, rows and whiteboards store an empty
 * title instead; this legacy value is treated the same way so it reads in the
 * viewer's language rather than as English data.
 */
const LEGACY_PLACEHOLDER_TITLE = "Untitled";

/** True when a stored Space title carries no real name of its own. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
	const trimmed = (title ?? "").trim();
	return trimmed === "" || trimmed === LEGACY_PLACEHOLDER_TITLE;
}

/**
 * The value a Space title input should hold: empty for a placeholder title, so
 * the input shows its localized "Untitled" placeholder instead of stored text.
 */
export function editableSpaceTitle(title: string | null | undefined): string {
	return isPlaceholderTitle(title) ? "" : (title ?? "");
}

/**
 * The title to show for a Space document in a tab, list, card or link: the
 * stored title, or the viewer's localized "Untitled" when it has none.
 */
export function spaceDisplayTitle(
	title: string | null | undefined,
	tl: LiteralMessage
): string {
	return isPlaceholderTitle(title) ? tl("Untitled") : (title ?? "");
}
