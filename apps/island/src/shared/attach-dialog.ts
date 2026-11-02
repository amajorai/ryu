// Copy for the native image picker behind the Island's attach action.
//
// Electron's main process has no translator, so the renderer sends the dialog
// title and the file-type filter name already translated over the
// `system:attachFiles` IPC. Both are optional: an older renderer, a missing
// value or anything malformed falls back to the English source copy.

/** Translated picker copy the renderer may pass to `attachFiles`. */
export interface IslandAttachDialogLabels {
	/** Name of the image file-type filter (the "Images" entry). */
	filterName?: string;
	/** Title of the picker window. */
	title?: string;
}

/** English source copy, used when the renderer sends none. */
export const ATTACH_DIALOG_SOURCE_COPY = {
	filterName: "Images",
	title: "Attach images",
} as const;

/** Longest label accepted from the renderer; longer values are ignored. */
const MAX_LABEL_LENGTH = 200;

function label(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= MAX_LABEL_LENGTH
		? trimmed
		: fallback;
}

/** Read untrusted IPC input into the picker copy, field by field. */
export function attachDialogLabels(
	raw: unknown
): Required<IslandAttachDialogLabels> {
	const input =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	return {
		filterName: label(input.filterName, ATTACH_DIALOG_SOURCE_COPY.filterName),
		title: label(input.title, ATTACH_DIALOG_SOURCE_COPY.title),
	};
}
