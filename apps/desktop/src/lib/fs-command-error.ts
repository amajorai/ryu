// Words the coded failures the workspace-item and data-folder commands reject
// with (`src-tauri/src/fs_command_error.rs`). The native layer sends a stable
// `code` and a technical `detail` (the raw OS error or `ryu-core` stderr); each
// code maps to one whole translated sentence here. The detail and any uncoded
// error text are logged, never shown as the sentence.

import type { LiteralMessage } from "@ryu/i18n/react";

export type FsCommandErrorCode =
	| "core_missing"
	| "core_running"
	| "core_stop_failed"
	| "data_command_failed"
	| "destination_exists"
	| "editor_unavailable"
	| "into_descendant"
	| "invalid_name"
	| "invalid_path"
	| "item_unavailable"
	| "launch_failed"
	| "list_failed"
	| "move_failed"
	| "outside_project"
	| "passphrase_required"
	| "unsupported_item"
	| "update_pending"
	| "workspace_unavailable"
	| "wrong_passphrase";

/** The wire shape: `{ code, detail? }`. */
export interface FsCommandError {
	code: FsCommandErrorCode | (string & {});
	detail?: string | null;
}

export function isFsCommandError(value: unknown): value is FsCommandError {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { code?: unknown }).code === "string"
	);
}

/** The translated sentence for a known code, or `null` for an unknown one. */
export function fsCommandErrorSentence(
	error: FsCommandError,
	tl: LiteralMessage
): string | null {
	switch (error.code) {
		case "destination_exists":
			return tl("An item with that name already exists here.");
		case "into_descendant":
			return tl("A folder can't be moved into itself.");
		case "invalid_name":
			return tl("That name can't be used for a file or folder.");
		case "outside_project":
			return tl("That location is outside the project folder.");
		case "item_unavailable":
			return tl("That item no longer exists. Refresh the file list.");
		case "unsupported_item":
			return tl("Only files and folders can be moved.");
		case "workspace_unavailable":
			return tl("The project folder can't be opened.");
		case "list_failed":
			return tl("Ryu couldn't list the files in this project.");
		case "move_failed":
			return tl("Ryu couldn't move that item.");
		case "update_pending":
			return tl("Finish the app update before changing the data folder.");
		case "core_running":
			return tl(
				"The local runtime is still running and couldn't be stopped. Try again in a moment."
			);
		case "core_stop_failed":
			return tl("Ryu couldn't stop the local runtime. Try again.");
		case "core_missing":
			return tl("Ryu couldn't find its local runtime. Reinstall Ryu.");
		case "passphrase_required":
			return tl(
				"This backup is encrypted. Enter its passphrase to restore it."
			);
		case "wrong_passphrase":
			return tl(
				"That passphrase didn't unlock the backup, or the file is damaged."
			);
		case "invalid_path":
			return tl("That path can't be opened.");
		case "editor_unavailable":
			return tl("That app isn't available on this computer.");
		case "launch_failed":
			return tl("Ryu couldn't start the app to open that item.");
		default:
			// `data_command_failed` and unknown codes: the caller's sentence.
			return null;
	}
}

/** Log a failure's technical detail (or uncoded text); never shown. */
export function logFsCommandError(error: unknown): void {
	if (isFsCommandError(error)) {
		if (error.detail) {
			console.warn(`[fs-command] ${error.code}: ${error.detail}`);
		}
	} else if (error !== undefined && error !== null && error !== "") {
		console.warn("[fs-command] command failed:", error);
	}
}

/**
 * One translated sentence for a workspace-item or data-folder failure. A coded
 * native rejection maps to its own sentence; anything else (an older build's
 * English string, a JS error) gets the localized `fallback`, so raw OS or
 * runtime text never reaches the UI. Pure: pair it with `logFsCommandError`.
 */
export function fsCommandErrorMessage(
	error: unknown,
	tl: LiteralMessage,
	fallback: string
): string {
	return (
		(isFsCommandError(error) ? fsCommandErrorSentence(error, tl) : null) ??
		fallback
	);
}

/** `fsCommandErrorMessage` after logging the technical detail. */
export function fsCommandErrorText(
	error: unknown,
	tl: LiteralMessage,
	fallback: string
): string {
	logFsCommandError(error);
	return fsCommandErrorMessage(error, tl, fallback);
}

/**
 * The toast for a failed `open_workspace_item`, `reveal_workspace_item` or
 * `open_in_editor`: a translated title plus, for a coded rejection, its whole
 * translated sentence. Raw OS or spawn text is logged, never shown.
 */
export function workspaceItemOpenErrorToast(
	error: unknown,
	tl: LiteralMessage
): { description?: string; title: string } {
	logFsCommandError(error);
	const description = isFsCommandError(error)
		? fsCommandErrorSentence(error, tl)
		: null;
	const title = tl("Couldn't open that workspace item");
	return description ? { description, title } : { title };
}

/**
 * The @pierre/trees drop and rename handlers report a model-side collision as
 * an English string (`Destination already exists: "…"` or `"…" already
 * exists.`); the library exposes no error type, so the collision is matched by
 * text. Any other failure gets the caller's localized `fallback`.
 */
export function fileTreeModelErrorText(
	message: string,
	tl: LiteralMessage,
	fallback: string
): string {
	console.warn("[file-tree] model refused:", message);
	return /already exists/i.test(message)
		? tl("An item with that name already exists here.")
		: fallback;
}
