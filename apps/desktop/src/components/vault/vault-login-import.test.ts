// Choices and wording of the login import. Every value here is made up.

import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { ApiError } from "@/src/lib/api/client.ts";
import type {
	LoginImportPreview,
	LoginImportPreviewRow,
} from "@/src/lib/api/vault-login-import.ts";
import {
	droppedAuthenticatorKeys,
	LOGIN_IMPORT_FORMAT_NAMES,
	loginImportChoices,
	loginImportErrorMessage,
	loginImportOutcomeCount,
	loginImportProblem,
	loginImportRows,
} from "./vault-login-import.ts";

// A stand-in translator that marks what it was asked to translate.
const tl: LiteralMessage = (source) => `[${source}]`;

function row(
	number: number,
	status: LoginImportPreviewRow["status"],
	extra: Partial<LoginImportPreviewRow> = {}
): LoginImportPreviewRow {
	return {
		hasNotes: false,
		hasTotp: false,
		host: "example.com",
		row: number,
		site: "https://example.com/",
		status,
		totpDropped: false,
		username: `user${number}`,
		...extra,
	};
}

const PREVIEW: LoginImportPreview = {
	counts: { duplicate: 2, invalid: 1, new: 2, repeated: 1, total: 6 },
	environment: "default",
	format: "bitwarden",
	path: "/",
	rows: [
		row(2, "new"),
		row(3, "duplicate", {
			existing: { id: "itm_3", key: "example", version: 4 },
		}),
		row(4, "invalid", { problem: "no_password" }),
		row(5, "duplicate", {
			existing: { id: "itm_5", key: "other", version: 1 },
			totpDropped: true,
		}),
		row(6, "repeated", { problem: "repeated" }),
		row(7, "new", { totpDropped: true }),
	],
};

test("every new record is sent and a duplicate only when it was selected", () => {
	expect(loginImportChoices(PREVIEW, new Set())).toEqual({
		replace: [],
		rows: [2, 7],
	});
	expect(loginImportChoices(PREVIEW, new Set([5]))).toEqual({
		replace: [{ expectedId: "itm_5", expectedVersion: 1, row: 5 }],
		rows: [2, 7],
	});
});

test("selecting a record that is not a duplicate replaces nothing", () => {
	// Rows 2 (new), 4 (invalid) and 6 (repeated) cannot be replacements.
	expect(loginImportChoices(PREVIEW, new Set([2, 4, 6])).replace).toEqual([]);
	const noTarget: LoginImportPreview = {
		...PREVIEW,
		rows: [row(3, "duplicate")],
	};
	expect(loginImportChoices(noTarget, new Set([3]))).toEqual({
		replace: [],
		rows: [],
	});
});

test("records are grouped by status and unusable authenticator keys counted", () => {
	expect(loginImportRows(PREVIEW, "duplicate").map((item) => item.row)).toEqual(
		[3, 5]
	);
	expect(loginImportRows(PREVIEW, "invalid").map((item) => item.row)).toEqual([
		4,
	]);
	expect(droppedAuthenticatorKeys(PREVIEW)).toBe(2);
	expect(LOGIN_IMPORT_FORMAT_NAMES[PREVIEW.format]).toBe("Bitwarden");
});

test("outcomes of an import are counted by kind", () => {
	const result = {
		created: 1,
		replaced: 0,
		rows: [
			{ key: "example.com--abc", outcome: "created" as const, row: 2 },
			{ outcome: "denied" as const, row: 7 },
			{ outcome: "conflict" as const, row: 5 },
			{ outcome: "denied" as const, row: 8 },
		],
		skipped: 3,
	};
	expect(loginImportOutcomeCount(result, "denied")).toBe(2);
	expect(loginImportOutcomeCount(result, "conflict")).toBe(1);
	expect(loginImportOutcomeCount(result, "replaced")).toBe(0);
});

test("each problem code has its own sentence and an unknown one a general sentence", () => {
	expect(loginImportProblem("malformed", tl)).toBe(
		"[The columns do not match the header row.]"
	);
	expect(loginImportProblem("not_login", tl)).toBe(
		"[This entry is not a login.]"
	);
	expect(loginImportProblem("no_site", tl)).toBe("[No website address.]");
	expect(loginImportProblem("no_password", tl)).toBe("[No password.]");
	expect(loginImportProblem("invalid_value", tl)).toBe(
		"[A value is too long or spans several lines.]"
	);
	for (const code of ["made_up_code", undefined]) {
		expect(loginImportProblem(code, tl)).toBe(
			"[This record cannot be imported.]"
		);
	}
});

test("a refused file is explained by its code, not by Core's English", () => {
	const refused = (message: string) =>
		loginImportErrorMessage(
			new ApiError(
				"/api/vault/login-imports/preview",
				400,
				`vault_invalid_request: ${message}`
			),
			tl
		);
	expect(refused("login_import_unknown_format: the first row is not")).toBe(
		"[This file is not a password export from Chrome, Firefox, Safari, Bitwarden or 1Password.]"
	);
	expect(refused("login_import_empty: the file holds no logins")).toBe(
		"[This file holds no logins.]"
	);
	expect(refused("login_import_unreadable: record 2 has a quote")).toBe(
		"[This file cannot be read. A quoted value never closes.]"
	);
	expect(refused("login_import_too_many_rows: the file holds more")).toBe(
		"[This file holds too many logins. Split it and import the parts.]"
	);
});

test("other failures use the vault wording and a failure without a message the fallback", () => {
	expect(
		loginImportErrorMessage(
			new ApiError(
				"/api/vault/login-imports",
				400,
				"vault_invalid_request: more records are chosen than the file holds"
			),
			tl
		)
	).toBe("[More records are chosen than the file holds]");
	expect(
		loginImportErrorMessage(new ApiError("/api/vault/login-imports", 500), tl)
	).toBe("Could not import.");
});
