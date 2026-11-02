// Words the coded failures Quick Capture and Clips quick attach report from Rust
// (`src-tauri/src/quick_capture/native_error.rs`). The native layer sends a stable
// `code` (plus `status` for a Core rejection) and keeps any technical cause in
// `detail`; each code maps to one whole translated sentence here, and `detail`
// is only ever a secondary technical line.

import type { LiteralMessage } from "@ryu/i18n/react";

export type NativeCaptureErrorCode =
	| "core_rejected"
	| "core_unreachable"
	| "input_monitoring_denied"
	| "invalid_response"
	| "quests_disabled"
	| "settings_save_failed"
	| "unsupported_platform"
	| "worker_failed";

/** The wire shape: `{ code, status?, detail? }`. */
export interface NativeCaptureError {
	code: NativeCaptureErrorCode | (string & {});
	detail?: string | null;
	status?: number | null;
}

export interface NativeCaptureErrorCopy {
	/** Technical cause, shown under the sentence, never translated. */
	detail: string | null;
	/** The translated sentence. */
	message: string;
}

function isCodedError(value: unknown): value is NativeCaptureError {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { code?: unknown }).code === "string"
	);
}

function sentenceFor(
	error: NativeCaptureError,
	tl: LiteralMessage
): string | null {
	switch (error.code) {
		case "input_monitoring_denied":
			return tl(
				"Grant Input Monitoring to Ryu in System Settings › Privacy & Security, then restart Ryu."
			);
		case "quests_disabled":
			return tl(
				"The Quests app is turned off. Enable it from the Store and try again."
			);
		case "core_unreachable":
			return tl(
				"Couldn't reach Ryu Core. Make sure Ryu is running and try again."
			);
		case "core_rejected":
			return typeof error.status === "number"
				? tl("Ryu Core rejected the capture (HTTP {status}).", {
						status: String(error.status),
					})
				: tl("Ryu Core rejected the capture.");
		case "invalid_response":
			return tl("Ryu Core sent a reply Ryu couldn't read.");
		case "worker_failed":
			return tl(
				"Ryu couldn't start the keyboard listener. Restart Ryu and try again."
			);
		case "settings_save_failed":
			return tl("Ryu couldn't save this setting.");
		case "unsupported_platform":
			return tl("This shortcut isn't available on this platform.");
		default:
			return null;
	}
}

/**
 * Turn whatever a native command rejected with, or a status/event `error` field,
 * into a translated sentence plus an optional technical detail. An unknown code
 * (a newer native build) falls back to its detail; a bare string or `Error`
 * (an older build, or a failure outside Rust) is shown as-is.
 */
export function describeNativeCaptureError(
	error: unknown,
	tl: LiteralMessage,
	fallback: string
): NativeCaptureErrorCopy {
	if (isCodedError(error)) {
		const detail = error.detail?.trim() || null;
		const sentence = sentenceFor(error, tl);
		if (sentence) {
			return { detail, message: sentence };
		}
		return { detail: null, message: detail ?? fallback };
	}
	if (error instanceof Error && error.message) {
		return { detail: null, message: error.message };
	}
	if (typeof error === "string" && error.trim()) {
		return { detail: null, message: error };
	}
	return { detail: null, message: fallback };
}

/** One line for a toast or settings caption: the sentence, then the detail. */
export function formatNativeCaptureError(
	error: unknown,
	tl: LiteralMessage,
	fallback: string
): string {
	const { detail, message } = describeNativeCaptureError(error, tl, fallback);
	return detail
		? tl("{message} Details: {detail}", { detail, message })
		: message;
}
