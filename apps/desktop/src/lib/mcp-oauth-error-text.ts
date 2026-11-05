import { translate } from "@ryu/i18n/core";
import { ApiError } from "./api/client-api-error.ts";

/** A whole-sentence translator: `tl` from `@ryu/i18n/core` or `useLiteralMessages()`. */
export type McpOAuthTranslate = (source: string, values?: unknown) => string;

/**
 * The user-facing sentence for a failed MCP OAuth flow. Core sends an English
 * `error` plus a stable `error_code` (on the flow) or `code` (on a refused
 * confirmation); only the code is shown, worded here. An unknown or missing
 * code (an older node) gets the generic sentence.
 */
export function mcpOAuthErrorText(
	code: string | null | undefined,
	appName: string,
	tl: McpOAuthTranslate = translate
): string {
	const values = { appName };
	switch (code) {
		case "code_mismatch":
			return tl(
				"That code didn't match. Check the code your browser shows and try again."
			);
		case "too_many_attempts":
			return tl(
				"Too many incorrect codes. Connect {appName} again to get a new code.",
				values
			);
		case "expired":
			return tl("The sign-in for {appName} expired. Connect it again.", values);
		case "cancelled":
			return tl(
				"The sign-in for {appName} was cancelled. Connect it again.",
				values
			);
		case "not_awaiting":
			return tl(
				"This sign-in for {appName} is no longer waiting for a code. Connect it again.",
				values
			);
		case "issuer_mismatch":
			return tl(
				"Ryu couldn't verify the sign-in server for {appName}. Connect it again, or connect from this computer instead.",
				values
			);
		case "missing_code":
			return tl(
				"The sign-in for {appName} didn't finish in the browser. Connect it again.",
				values
			);
		case "invalid_state":
			return tl(
				"This sign-in link for {appName} was already used or isn't valid. Connect it again.",
				values
			);
		default:
			return tl("Couldn't connect {appName}.", values);
	}
}

/**
 * The code of a refused confirmation: the `code` Core attached, else, for an
 * older node's bare 400, a wrong code (the flow's own state tells the rest).
 */
export function mcpOAuthRefusalCode(error: unknown): string | null {
	if (!(error instanceof ApiError)) {
		return null;
	}
	return error.code ?? (error.status === 400 ? "code_mismatch" : null);
}
