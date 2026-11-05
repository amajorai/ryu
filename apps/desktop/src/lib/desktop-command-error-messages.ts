// Words the coded failures the file-resource, shell and update-scheduling
// commands reject with (`src-tauri/src/file_resource_error.rs`,
// `src-tauri/src/shell_exec_error.rs`, `src-tauri/src/update_schedule_error.rs`).
// The native layer rejects with a plain `code[:detail]` string and never words
// a sentence; each code maps to one whole translated sentence here. A folder
// path is interpolated as a value; raw OS or decoder text stays a secondary
// detail, never the sentence.

import type { LiteralMessage } from "@ryu/i18n/react";

export type DesktopCommandErrorCode =
	| "cwd_not_dir"
	| "file_too_large"
	| "invalid_content"
	| "invalid_cwd"
	| "invalid_env_name"
	| "invalid_request"
	| "io"
	| "no_config_dir"
	| "spawn_failed"
	| "write_failed";

/** The code a size-bounded file read or write rejects with. */
export const FILE_TOO_LARGE_CODE = "file_too_large";

const CODES: ReadonlySet<string> = new Set<DesktopCommandErrorCode>([
	"cwd_not_dir",
	"file_too_large",
	"invalid_content",
	"invalid_cwd",
	"invalid_env_name",
	"invalid_request",
	"io",
	"no_config_dir",
	"spawn_failed",
	"write_failed",
]);

export interface DesktopCommandError {
	code: DesktopCommandErrorCode;
	/** The text after the first colon: a path, a name or a raw cause. */
	detail: string | null;
}

/** The sentence to show plus the raw cause, if any, for secondary text. */
export interface DesktopCommandErrorText {
	detail: string | null;
	message: string;
}

/** The raw rejection text: Tauri rejects with a string, JS code with an Error. */
export function desktopCommandRejectionText(error: unknown): string | null {
	if (typeof error === "string") {
		return error;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return null;
}

/** The parsed `code[:detail]` rejection, or `null` for uncoded text. */
export function parseDesktopCommandError(
	error: unknown
): DesktopCommandError | null {
	const raw = desktopCommandRejectionText(error);
	if (raw === null) {
		return null;
	}
	const separator = raw.indexOf(":");
	const code = separator === -1 ? raw : raw.slice(0, separator);
	if (!CODES.has(code)) {
		return null;
	}
	const detail = separator === -1 ? "" : raw.slice(separator + 1);
	return {
		code: code as DesktopCommandErrorCode,
		detail: detail === "" ? null : detail,
	};
}

/** The translated sentence for a coded rejection, or `null` for uncoded text. */
export function desktopCommandErrorText(
	error: unknown,
	tl: LiteralMessage
): DesktopCommandErrorText | null {
	const parsed = parseDesktopCommandError(error);
	if (!parsed) {
		return null;
	}
	const { code, detail } = parsed;
	switch (code) {
		case "file_too_large":
			return {
				message: tl("This file is too large to annotate here."),
				detail,
			};
		case "io":
		case "invalid_content":
			return { message: tl("This file could not be read."), detail };
		case "invalid_cwd":
			return {
				message: tl("The working directory {dir} does not exist.", {
					dir: detail ?? "",
				}),
				detail: null,
			};
		case "cwd_not_dir":
			return {
				message: tl("{dir} is not a folder.", { dir: detail ?? "" }),
				detail: null,
			};
		case "invalid_env_name":
		case "spawn_failed":
			return { message: tl("The command could not be run."), detail };
		case "invalid_request":
			return {
				message: tl(
					"The time or version for this scheduled update is not valid."
				),
				detail,
			};
		case "no_config_dir":
			return {
				message: tl(
					"Ryu could not find this computer's settings folder, so the update cannot be scheduled."
				),
				detail,
			};
		case "write_failed":
			return {
				message: tl(
					"Ryu could not save the scheduled update. Check that its settings folder can be written to, then try again."
				),
				detail,
			};
		default:
			return null;
	}
}

/**
 * One line for a plain-text surface (terminal, empty state): the translated
 * sentence, or the uncoded rejection text unchanged (real tool output).
 */
export function desktopCommandErrorLine(
	error: unknown,
	tl: LiteralMessage
): string {
	const coded = desktopCommandErrorText(error, tl);
	if (coded) {
		return coded.message;
	}
	return desktopCommandRejectionText(error) ?? String(error);
}

/**
 * Terminal error lines for a rejected `shell_execute`: the translated sentence,
 * then the raw cause (spawn or OS text) as its own line when there is one.
 */
export function terminalErrorLines(
	error: unknown,
	tl: LiteralMessage
): { text: string; type: "error" }[] {
	const coded = desktopCommandErrorText(error, tl);
	if (!coded) {
		return [{ type: "error", text: desktopCommandErrorLine(error, tl) }];
	}
	const lines = [{ type: "error" as const, text: coded.message }];
	if (coded.detail) {
		lines.push({ type: "error", text: coded.detail });
	}
	return lines;
}
