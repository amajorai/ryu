// Words the coded refusals of Core's data-folder endpoints
// (`apps/core/src/server/data_path_api/reason.rs`). Core keeps its English
// `error` text for older clients and sends a stable code plus raw values next
// to it: `reason_code` / `reason_values` on a validation, `code` / `values` on
// a refused switch or export. Each code maps to one whole translated sentence
// here, with sizes in the reader's locale. Core's English text and OS errors
// are logged, never shown.

import { formatByteSize } from "@ryu/i18n/format-intl";
import type { LiteralMessage } from "@ryu/i18n/react";

type DataPathValues = Readonly<Record<string, unknown>>;

/** A refusal Core answered with `{ ok: false, ... }` on a 200 response. */
export class DataPathRefusal extends Error {
	readonly body: Readonly<Record<string, unknown>>;

	constructor(body: Readonly<Record<string, unknown>>) {
		super(typeof body.error === "string" ? body.error : "data-path refused");
		this.name = "DataPathRefusal";
		this.body = body;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteCount(values: DataPathValues, key: string): number {
	const value = values[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One decimal at every scale ("4.7 GB", "4,7 GB"), like the rest of the tab. */
function bytes(count: number, locale?: string): string {
	return formatByteSize(count, locale, {
		fractionDigits: 1,
		maxUnit: "terabyte",
	});
}

/** The sentence for a known code, or `null` for an unknown or generic one. */
export function dataPathReasonSentence(
	code: string | undefined,
	values: DataPathValues,
	tl: LiteralMessage,
	locale?: string
): string | null {
	switch (code) {
		case "invalid_path":
			return tl("That path can't be opened.");
		case "nested":
			return tl(
				"The new folder can't be inside the current data folder, or contain it."
			);
		case "not_empty":
			return tl("This folder isn't empty. Pick an empty or new folder.");
		case "not_writable":
			return tl("Ryu can't write to this folder.");
		case "insufficient_space":
			return tl("Not enough free space: {need} needed, {free} available.", {
				need: bytes(byteCount(values, "need_bytes"), locale),
				free: bytes(byteCount(values, "free_bytes"), locale),
			});
		case "passphrase_too_short":
			return tl("The backup passphrase must be at least {count} characters.", {
				count: byteCount(values, "min_chars"),
			});
		case "export_inside_data_folder":
			return tl("Save the backup outside the data folder.");
		case "export_no_parent":
		case "export_symlink":
			return tl("The backup can't be saved to that location.");
		case "export_not_active_folder":
			return tl(
				"Only the active data folder can be backed up. Switch to this folder first."
			);
		case "export_shared_node":
			return tl(
				"Backing up the whole data folder is turned off on a shared node, because it holds other people's data."
			);
		default:
			return null;
	}
}

/**
 * The inline reason for a failed validation. An uncoded reason (an older
 * Core's English text) gets a translated generic sentence instead.
 */
export function dataPathValidationText(
	validation: {
		error?: string;
		reason_code?: unknown;
		reason_values?: unknown;
	},
	tl: LiteralMessage,
	locale?: string
): string {
	const code =
		typeof validation.reason_code === "string"
			? validation.reason_code
			: undefined;
	const values = isRecord(validation.reason_values)
		? validation.reason_values
		: {};
	const sentence = dataPathReasonSentence(code, values, tl, locale);
	if (!sentence && validation.error) {
		console.warn("[data-path] uncoded refusal:", validation.error);
	}
	return sentence ?? tl("This folder can't be used as the data folder.");
}

/** The coded body a switch, reset or export failure carries, if any. */
function refusalBody(error: unknown): Readonly<Record<string, unknown>> | null {
	if (!isRecord(error)) {
		return null;
	}
	if (isRecord(error.body)) {
		return error.body;
	}
	return typeof error.code === "string" ? error : null;
}

/**
 * One translated sentence for a failed switch, reset or export: a coded
 * refusal gets its own sentence, anything else the caller's localized
 * `fallback`. Core's English text and JS error text are logged, never shown.
 */
export function dataPathErrorText(
	error: unknown,
	tl: LiteralMessage,
	fallback: string,
	locale?: string
): string {
	const body = refusalBody(error);
	const code = typeof body?.code === "string" ? body.code : undefined;
	const values = isRecord(body?.values) ? body.values : {};
	console.warn("[data-path] request failed:", code ?? "", error);
	return dataPathReasonSentence(code, values, tl, locale) ?? fallback;
}

/** The HTTP status of a refused request (an `ApiError`), if any. */
function httpStatus(error: unknown): number | null {
	return isRecord(error) && typeof error.status === "number"
		? error.status
		: null;
}

/** Which Storage action failed. */
export type DataPathAction = "export" | "reset" | "switch";

/** The localized sentence for an uncoded failure, with the HTTP status when known. */
function actionFallback(
	action: DataPathAction,
	status: number | null,
	tl: LiteralMessage
): string {
	const values = { status: String(status) };
	switch (action) {
		case "switch":
			return status === null
				? tl("Ryu couldn't switch the data folder.")
				: tl("Ryu couldn't switch the data folder (error {status}).", values);
		case "reset":
			return status === null
				? tl("Ryu couldn't reset the data folder.")
				: tl("Ryu couldn't reset the data folder (error {status}).", values);
		default:
			return status === null
				? tl("Ryu couldn't create the backup.")
				: tl("Ryu couldn't create the backup (error {status}).", values);
	}
}

/** The toast description for a failed switch, reset or export. */
export function dataPathActionErrorText(
	action: DataPathAction,
	error: unknown,
	tl: LiteralMessage
): string {
	return dataPathErrorText(
		error,
		tl,
		actionFallback(action, httpStatus(error), tl)
	);
}
