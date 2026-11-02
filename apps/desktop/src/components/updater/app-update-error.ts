// Words the coded failures the app-update commands reject with
// (`src-tauri/src/update_error.rs`). The native layer sends a stable `code`, the
// raw `values` a sentence interpolates and a technical `detail`; each code maps
// to one whole translated sentence here. The detail and any uncoded English
// error text are logged, never shown as the sentence.

import type { LiteralMessage } from "@ryu/i18n/react";

export type AppUpdateErrorCode =
	| "already_waiting"
	| "cache_failed"
	| "confirm_failed"
	| "download_failed"
	| "feed_moved"
	| "handoff_failed"
	| "handoff_unavailable"
	| "not_configured"
	| "not_main_window"
	| "prepared_mismatch"
	| "runtime_prepare_failed"
	| "runtime_restart_failed"
	| "runtime_still_running"
	| "runtime_stop_failed"
	| "signature_invalid";

/** The wire shape: `{ code, values?, detail? }`. */
export interface AppUpdateError {
	code: AppUpdateErrorCode | (string & {});
	detail?: string | null;
	values?: Record<string, string> | null;
}

export function isAppUpdateError(value: unknown): value is AppUpdateError {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { code?: unknown }).code === "string"
	);
}

function value(error: AppUpdateError, name: string): string {
	return error.values?.[name] ?? "";
}

/** The translated sentence for a known code, or `null` for an unknown one. */
export function appUpdateErrorSentence(
	error: AppUpdateError,
	tl: LiteralMessage
): string | null {
	switch (error.code) {
		case "already_waiting":
			return tl("An app update is already waiting for restart.");
		case "not_main_window":
			return tl("Only the main Ryu window can change app updates.");
		case "not_configured":
			return tl("This build of Ryu can't install app updates.");
		case "download_failed":
			return tl(
				"Ryu couldn't download the update. Check your connection and try again."
			);
		case "signature_invalid":
			return tl(
				"The downloaded update failed its signature check. Download it again."
			);
		case "feed_moved":
			return tl(
				"The update changed from v{expected} to v{offered}. Check for updates again before downloading.",
				{ expected: value(error, "expected"), offered: value(error, "offered") }
			);
		case "prepared_mismatch":
			return tl(
				"The downloaded update no longer matches the published release. Download it again."
			);
		case "cache_failed":
			return tl("Ryu couldn't save or read the downloaded update.");
		case "runtime_prepare_failed":
			return tl("Ryu couldn't prepare the runtime for this update.");
		case "handoff_unavailable":
			return tl(
				"This update can't be installed automatically. Download it from the release page."
			);
		case "runtime_stop_failed":
			return tl(
				"Ryu couldn't stop the local runtime, so the update was not started."
			);
		case "runtime_still_running":
			return tl(
				"The local runtime is still running, so the update was not started. Try again in a moment."
			);
		case "runtime_restart_failed":
			return tl(
				"The update failed and the previous runtime couldn't restart. Restart Ryu."
			);
		case "handoff_failed":
			return tl("Ryu couldn't hand the update to its installer. Try again.");
		case "confirm_failed":
			return tl("Ryu couldn't ask before installing the update. Try again.");
		default:
			return null;
	}
}

/**
 * One translated sentence for an updater failure. A coded native rejection
 * (`update_error.rs`) maps to its own sentence; anything else — an older
 * build's English string, a plugin or JS error, JSON or socket text — is logged
 * and replaced by the localized `fallback`, so raw text never reaches a toast.
 */
export function updateErrorSentence<TError>(
	error: TError,
	tl: LiteralMessage,
	fallback: string
): string {
	if (isAppUpdateError(error)) {
		const sentence = appUpdateErrorSentence(error, tl);
		if (error.detail) {
			console.warn(`[app-update] ${error.code}: ${error.detail}`);
		}
		if (sentence) {
			return sentence;
		}
	} else if (error !== undefined && error !== null && error !== "") {
		console.warn("[app-update] update failed:", error);
	}
	return fallback;
}
