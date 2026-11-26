// Choices and wording for the login import dialog. Nothing here holds or
// shows a password: a preview carries none.

import type { LiteralMessage } from "@ryu/i18n/react";
import { ApiError } from "@/src/lib/api/client.ts";
import type {
	LoginImportFormat,
	LoginImportPreview,
	LoginImportPreviewRow,
	LoginImportReplace,
	LoginImportResult,
} from "@/src/lib/api/vault-login-import.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

/** Product names, which are the same in every language. */
export const LOGIN_IMPORT_FORMAT_NAMES: Record<LoginImportFormat, string> = {
	"1password": "1Password",
	bitwarden: "Bitwarden",
	chrome: "Chrome",
	firefox: "Firefox",
	safari: "Safari",
};

/** Most records the dialog lists one by one. Counts always cover every record. */
export const LOGIN_IMPORT_LIST_LIMIT = 50;

/**
 * What an import sends: every new record, and a replacement for each
 * duplicate the user selected. A duplicate that is not selected is left out,
 * so its saved login is never touched.
 */
export function loginImportChoices(
	preview: LoginImportPreview,
	replaceRows: ReadonlySet<number>
): { replace: LoginImportReplace[]; rows: number[] } {
	const rows: number[] = [];
	const replace: LoginImportReplace[] = [];
	for (const row of preview.rows) {
		if (row.status === "new") {
			rows.push(row.row);
		} else if (
			row.status === "duplicate" &&
			row.existing &&
			replaceRows.has(row.row)
		) {
			replace.push({
				expectedId: row.existing.id,
				expectedVersion: row.existing.version,
				row: row.row,
			});
		}
	}
	return { replace, rows };
}

/** The records with `status`, in file order. */
export function loginImportRows(
	preview: LoginImportPreview,
	status: LoginImportPreviewRow["status"]
): LoginImportPreviewRow[] {
	return preview.rows.filter((row) => row.status === status);
}

/** How many records had an authenticator key that cannot be used. */
export function droppedAuthenticatorKeys(preview: LoginImportPreview): number {
	return preview.rows.filter((row) => row.totpDropped).length;
}

/** How many chosen records ended with `outcome`. */
export function loginImportOutcomeCount(
	result: LoginImportResult,
	outcome: LoginImportResult["rows"][number]["outcome"]
): number {
	return result.rows.filter((row) => row.outcome === outcome).length;
}

/** Why a record cannot be imported, from Core's stable code. */
export function loginImportProblem(
	problem: string | undefined,
	tl: LiteralMessage
): string {
	switch (problem) {
		case "malformed":
			return tl("The columns do not match the header row.");
		case "not_login":
			return tl("This entry is not a login.");
		case "no_site":
			return tl("No website address.");
		case "no_password":
			return tl("No password.");
		case "invalid_value":
			return tl("A value is too long or spans several lines.");
		default:
			return tl("This record cannot be imported.");
	}
}

/** The sentence for a refused file, from the code in Core's message. */
function refusedFileMessage(
	serverMessage: string,
	tl: LiteralMessage
): string | null {
	if (serverMessage.includes("login_import_unknown_format")) {
		return tl(
			"This file is not a password export from Chrome, Firefox, Safari, Bitwarden or 1Password."
		);
	}
	if (serverMessage.includes("login_import_empty")) {
		return tl("This file holds no logins.");
	}
	if (serverMessage.includes("login_import_unreadable")) {
		return tl("This file cannot be read. A quoted value never closes.");
	}
	if (serverMessage.includes("login_import_too_many_rows")) {
		return tl(
			"This file holds too many logins. Split it and import the parts."
		);
	}
	return null;
}

/** A readable message for a failed preview or import. */
export function loginImportErrorMessage<TError>(
	error: TError,
	tl: LiteralMessage
): string {
	if (error instanceof ApiError && error.serverMessage) {
		const refused = refusedFileMessage(error.serverMessage, tl);
		if (refused) {
			return refused;
		}
	}
	return vaultErrorMessage(error, "Could not import.", tl);
}
