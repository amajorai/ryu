// Pure picking helpers for the agent account catalog (see ./agentAccountCatalog.ts).

import { tf } from "../i18n/translate.ts";
import type {
	AvailableAccount,
	AvailableAccounts,
} from "./agentAccountCatalog-types.ts";
import { accountKeyKind } from "./agentIdentity.ts";

// ── Picking (pure) ──────────────────────────────────────────────────────────

/** Every listed row, in display order, de-duplicated by key. */
export function listedAccounts(
	accounts: AvailableAccounts
): AvailableAccount[] {
	const seen = new Set<string>();
	const rows: AvailableAccount[] = [];
	for (const entry of accounts.sections) {
		for (const row of entry.rows) {
			if (!seen.has(row.key)) {
				seen.add(row.key);
				rows.push(row);
			}
		}
	}
	return rows;
}

/** Allowed keys the list does not show; a picker keeps them. */
export function keysNotListed(
	accountAccess: readonly string[] | null,
	accounts: AvailableAccounts
): string[] {
	if (accountAccess === null) {
		return [];
	}
	const listed = new Set(listedAccounts(accounts).map((row) => row.key));
	return accountAccess.filter((key) => !listed.has(key));
}

/** A row for a kept key that is not listed, labelled by its kind. */
export function notListedRow(key: string): AvailableAccount {
	return {
		detail: "Disconnected since, or not shown for how it works; kept",
		key,
		section: "not-listed",
		status: null,
		title: accountKeyKind(key)?.label ?? "Other",
	};
}

/** Whether the row is allowed: everything is under no limit. */
export function isAccountAllowed(
	accountAccess: readonly string[] | null,
	key: string
): boolean {
	return accountAccess === null || accountAccess.includes(key);
}

/**
 * Toggle one key. Toggling under no limit first starts a limit from every
 * listed account (desktop's "Limit to selected accounts" switch), so it only
 * ever narrows; every other key is kept untouched.
 */
export function toggleAccountAccess(
	accountAccess: readonly string[] | null,
	accounts: AvailableAccounts,
	key: string
): string[] {
	const current =
		accountAccess === null ? startAccountLimit(accounts) : [...accountAccess];
	return current.includes(key)
		? current.filter((existing) => existing !== key)
		: [...current, key];
}

/**
 * Why a limit can't start from the listed accounts now, or `null` when it can.
 * A fresh limit keeps only the accounts listed, so starting one while a section
 * failed to load would also take away that section's accounts, which the user
 * never saw to untick. Names the sections that failed.
 */
export function accountLimitStartBlocked(
	accounts: AvailableAccounts
): string | null {
	const failed = accounts.sections.filter((entry) => entry.error !== null);
	if (failed.length === 0) {
		return null;
	}
	const names = failed.map((entry) => entry.title).join(", ");
	return `Couldn't load ${names}, so a limit started now would also take those accounts away. Nothing was changed; try again once they load.`;
}

/** The list a fresh limit starts from: every listed account, Treg included. */
export function startAccountLimit(accounts: AvailableAccounts): string[] {
	return listedAccounts(accounts).map((row) => row.key);
}

/**
 * The rows a picker shows, in order: every listed account, then the keys the
 * saved list allows that are not listed now, so they can be seen and removed
 * rather than silently kept or dropped.
 */
export function accountPickerRows(
	accounts: AvailableAccounts,
	savedAccess: readonly string[] | null
): AvailableAccount[] {
	return [
		...listedAccounts(accounts),
		...keysNotListed(savedAccess, accounts).map(notListedRow),
	];
}

/** Every allowed key plus every listed one: what "all" selects. */
export function selectAllAccounts(
	accountAccess: readonly string[] | null,
	accounts: AvailableAccounts
): string[] {
	const next = [...(accountAccess ?? [])];
	for (const key of startAccountLimit(accounts)) {
		if (!next.includes(key)) {
			next.push(key);
		}
	}
	return next;
}

/** Whether two allowlists mean the same thing (order does not matter). */
export function sameAccountAccess(
	left: readonly string[] | null,
	right: readonly string[] | null
): boolean {
	if (left === null || right === null) {
		return left === right;
	}
	const a = new Set(left);
	const b = new Set(right);
	return a.size === b.size && [...a].every((key) => b.has(key));
}

export type PickCommand =
	| { kind: "toggle"; indexes: number[] }
	| { kind: "all" }
	| { kind: "none" }
	| { kind: "no-limit" }
	| { kind: "save" }
	| { kind: "cancel" }
	| { kind: "show" }
	| { kind: "invalid"; message: string };

const RANGE = /^(\d+)(?:-(\d+))?$/;
const SEPARATORS = /[\s,]+/;

/**
 * One line typed at the picker: row numbers and ranges to toggle ("1 3-5"),
 * or a word: all, none, unlimited, save, cancel. Empty shows the list again.
 */
export function parsePickCommand(input: string, rowCount: number): PickCommand {
	const text = input.trim().toLowerCase();
	switch (text) {
		case "":
			return { kind: "show" };
		case "all":
			return { kind: "all" };
		case "none":
			return { kind: "none" };
		case "unlimited":
		case "no-limit":
		case "nolimit":
		case "clear":
			return { kind: "no-limit" };
		case "s":
		case "save":
		case "done":
			return { kind: "save" };
		case "q":
		case "quit":
		case "cancel":
			return { kind: "cancel" };
		default:
			break;
	}
	const indexes: number[] = [];
	for (const token of text.split(SEPARATORS).filter(Boolean)) {
		const match = RANGE.exec(token);
		if (!match) {
			return {
				kind: "invalid",
				message: tf(
					"'{token}' is not a row number. Type numbers such as 1 3-5, or all, none, unlimited, save or cancel.",
					{ token }
				),
			};
		}
		const from = Number(match[1]);
		const to = match[2] === undefined ? from : Number(match[2]);
		if (from < 1 || to > rowCount || from > to) {
			return {
				kind: "invalid",
				message: tf("There is no row {token}. Rows go from 1 to {rowCount}.", {
					rowCount: String(rowCount),
					token,
				}),
			};
		}
		for (let index = from; index <= to; index += 1) {
			indexes.push(index - 1);
		}
	}
	return { kind: "toggle", indexes };
}
