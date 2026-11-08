import type { LiteralMessage } from "@ryu/i18n";

/**
 * The names and descriptions Core seeds its system Spaces with
 * (`ensure_system_space` in `apps/core`). Core stores them as English data, so a
 * system Space whose stored text still equals its seed is shown in the viewer's
 * language. Anything else (a Space the user renamed, or any ordinary Space) is
 * the user's own text and is shown as written. Display only: stored names are
 * never changed, and lookups by name keep using the stored value.
 */
const SEED_NAMES = new Set([
	"Uploads",
	"Artifacts",
	"Meetings",
	"Canvas",
	"Whiteboard",
]);

const SEED_DESCRIPTIONS = new Set([
	"Files you upload in chat and pages",
	"Files created by Ryu and agents",
	"Auto-saved meeting notes",
	"Node-based creative canvases",
]);

/** The fields of a Space row these helpers read. */
export interface SystemSpaceLabelSource {
	description?: string | null;
	name: string;
	system?: boolean;
}

/** The localized seed name, written out so the i18n extractor sees each key. */
function localizedSeedName(name: string, tl: LiteralMessage): string {
	switch (name) {
		case "Uploads":
			return tl("Uploads");
		case "Artifacts":
			return tl("Artifacts");
		case "Meetings":
			return tl("Meetings");
		case "Canvas":
			return tl("Canvas");
		case "Whiteboard":
			return tl("Whiteboard");
		default:
			return name;
	}
}

/** The localized seed description, written out so the extractor sees each key. */
function localizedSeedDescription(
	description: string,
	tl: LiteralMessage
): string {
	switch (description) {
		case "Files you upload in chat and pages":
			return tl("Files you upload in chat and pages");
		case "Files created by Ryu and agents":
			return tl("Files created by Ryu and agents");
		case "Auto-saved meeting notes":
			return tl("Auto-saved meeting notes");
		case "Node-based creative canvases":
			return tl("Node-based creative canvases");
		default:
			return description;
	}
}

/** The name to show for a Space: localized for an unrenamed system Space. */
export function spaceDisplayName(
	space: SystemSpaceLabelSource,
	tl: LiteralMessage
): string {
	if (space.system === true && SEED_NAMES.has(space.name)) {
		return localizedSeedName(space.name, tl);
	}
	return space.name;
}

/**
 * The description to show for a Space: localized when a system Space still
 * carries its seed description, otherwise the stored text (or null).
 */
export function spaceDisplayDescription(
	space: SystemSpaceLabelSource,
	tl: LiteralMessage
): string | null {
	const description = space.description ?? null;
	if (
		description !== null &&
		space.system === true &&
		SEED_DESCRIPTIONS.has(description)
	) {
		return localizedSeedDescription(description, tl);
	}
	return description;
}

/**
 * A display copy of a Space row with its name and description localized, for
 * components that render `space.name` directly. Returns the same object when
 * nothing changes, so memoized children do not re-render needlessly.
 */
export function withSpaceDisplayLabels<T extends SystemSpaceLabelSource>(
	space: T,
	tl: LiteralMessage
): T {
	const name = spaceDisplayName(space, tl);
	const description = spaceDisplayDescription(space, tl);
	if (name === space.name && description === (space.description ?? null)) {
		return space;
	}
	return { ...space, name, description };
}

/** Picker options for a list of Spaces, labelled with their display names. */
export function spaceSelectOptions(
	spaces: readonly (SystemSpaceLabelSource & { id: string })[],
	tl: LiteralMessage
): { label: string; value: string }[] {
	return spaces.map((space) => ({
		label: spaceDisplayName(space, tl),
		value: space.id,
	}));
}
