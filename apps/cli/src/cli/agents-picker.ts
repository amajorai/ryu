import {
	ACCOUNT_OWNER_HEADINGS,
	type AccountCatalogCore,
	type AccountSection,
	type AvailableAccount,
	type AvailableAccounts,
	accountLimitStartBlocked,
	accountPickerRows,
	isAccountAllowed,
	keysNotListed,
	loadAvailableAccounts,
	notListedRow,
	parsePickCommand,
	sameAccountAccess,
	selectAllAccounts,
	toggleAccountAccess,
} from "../core/agentAccountCatalog.ts";
import {
	accountAccessHeadline,
	accountAccessNote,
	accountKeyUnusedReason,
	identityModeLabel,
	isRemotePeerEngine,
} from "../core/agentIdentity.ts";
import type { AgentsArgs } from "./agents-args.ts";
import { type AgentIdentityView, viewJson } from "./agents-core.ts";
import {
	describeRemotePeer,
	output,
	refuseRemotePeerChange,
	requireEditable,
} from "./agents-output.ts";
import { engineFlag, saveAgentPatch, warnUnusedKeys } from "./agents-save.ts";
import { formatTable } from "./output.ts";
import { type CliContext, UsageError } from "./types.ts";

// ── Available accounts and the picker ───────────────────────────────────────

function catalogCore(ctx: CliContext): AccountCatalogCore {
	const call = ctx.api.call;
	if (!call) {
		throw new Error("This command requires the live Core client.");
	}
	// Errors stay Core's own (ApiError), so a section can say why it failed.
	return {
		get: (path) => call(ctx.target, path, { method: "GET" }),
		post: (path, body) => call(ctx.target, path, { method: "POST", body }),
	};
}

function loadAccountsFor(
	ctx: CliContext,
	view: AgentIdentityView,
	engine: string | null
): Promise<AvailableAccounts> {
	return loadAvailableAccounts(catalogCore(ctx), {
		agentId: view.id,
		engine: engine ?? view.engine,
		identityMode: view.identityMode,
		savedIdentityMode: view.identityMode,
	});
}

function accountLabel(row: AvailableAccount): string {
	return row.status ? `${row.title} (${row.status})` : row.title;
}

function rowNote(row: AvailableAccount, view: AgentIdentityView): string {
	if (row.section === "not-listed") {
		return [row.detail, accountKeyUnusedReason(row.key, view.identityMode)]
			.filter(Boolean)
			.join("; ");
	}
	return row.detail ?? "";
}

/** The lines under a section with no rows, or that failed to load. */
function sectionNotices(entry: AccountSection): string[] {
	if (entry.error) {
		return [entry.error];
	}
	return entry.rows.length === 0 && entry.empty ? [entry.empty] : [];
}

function availableJson(view: AgentIdentityView, accounts: AvailableAccounts) {
	const notListed = keysNotListed(view.accountAccess, accounts);
	return {
		...viewJson(view),
		accounts: accounts.sections.flatMap((entry) =>
			entry.rows.map((row) => ({
				key: row.key,
				title: row.title,
				detail: row.detail,
				status: row.status,
				section: entry.title,
				group: ACCOUNT_OWNER_HEADINGS[entry.owner],
				allowed: isAccountAllowed(view.accountAccess, row.key),
			}))
		),
		not_listed: notListed.map((key) => ({
			key,
			kind: notListedRow(key).title,
			unused_reason: accountKeyUnusedReason(key, view.identityMode),
		})),
		errors: accounts.sections.flatMap((entry) =>
			entry.error ? [{ section: entry.title, message: entry.error }] : []
		),
		hidden: accounts.hiddenGroups,
	};
}

function describeAvailable(
	view: AgentIdentityView,
	accounts: AvailableAccounts
): string {
	const lines = [
		`Accounts '${view.name}' can be allowed (${identityModeLabel(view.identityMode)}).`,
		`Account access: ${accountAccessHeadline(view.accountAccess)}`,
		"",
	];
	const rows = accounts.sections.flatMap((entry) =>
		entry.rows.map((row) => [
			isAccountAllowed(view.accountAccess, row.key) ? "yes" : "no",
			row.key,
			accountLabel(row),
			entry.title,
			row.detail ?? "",
		])
	);
	const notListed = keysNotListed(view.accountAccess, accounts).map(
		notListedRow
	);
	for (const row of notListed) {
		rows.push([
			"yes",
			row.key,
			row.title,
			"Not listed now",
			rowNote(row, view),
		]);
	}
	lines.push(
		formatTable(["ALLOWED", "KEY", "ACCOUNT", "SECTION", "DETAIL"], rows)
	);
	const notices = accounts.sections.flatMap((entry) =>
		sectionNotices(entry).map((text) => `  ${entry.title}: ${text}`)
	);
	if (notices.length > 0) {
		lines.push("", ...notices);
	}
	for (const hidden of accounts.hiddenGroups) {
		lines.push(`  ${hidden}`);
	}
	lines.push(
		"",
		`Allow or remove one with: ryu-cli agents access ${view.id} <add|remove> <key>…, or tick them with: ryu-cli agents access ${view.id} pick`
	);
	return lines.join("\n");
}

export async function availableCommand(
	ctx: CliContext,
	view: AgentIdentityView,
	args: AgentsArgs
): Promise<number> {
	if (isRemotePeerEngine(args.engine ?? view.engine)) {
		output(ctx, viewJson(view), describeRemotePeer().join("\n"));
		return 0;
	}
	const accounts = await loadAccountsFor(ctx, view, args.engine);
	output(ctx, availableJson(view, accounts), describeAvailable(view, accounts));
	return 0;
}

/** The numbered list the picker prints before each question. */
function renderPickList(
	view: AgentIdentityView,
	accounts: AvailableAccounts,
	rows: readonly AvailableAccount[],
	draft: readonly string[] | null
): string {
	const width = String(rows.length).length;
	const number = (row: AvailableAccount) =>
		String(rows.indexOf(row) + 1).padStart(width);
	const mark = (row: AvailableAccount) =>
		isAccountAllowed(draft, row.key) ? "[x]" : "[ ]";
	const line = (row: AvailableAccount) => {
		const note = rowNote(row, view);
		return `    ${number(row)} ${mark(row)} ${accountLabel(row)}${note ? ` · ${note}` : ""}`;
	};
	const lines = [
		`Account access for '${view.name}' · ${identityModeLabel(view.identityMode)}`,
		`${accountAccessHeadline(draft)}. ${accountAccessNote(draft, view.identityMode)}`,
	];
	let owner: string | null = null;
	for (const entry of accounts.sections) {
		if (entry.owner !== owner) {
			owner = entry.owner;
			lines.push("", ACCOUNT_OWNER_HEADINGS[entry.owner]);
		}
		// A section with nothing to tick is one line; one whose single row
		// carries its name (Treg, Control of your desktop) has no title.
		const notices = sectionNotices(entry);
		if (notices.length > 0) {
			lines.push(`  ${entry.title}: ${notices.join(" ")}`);
		} else if (entry.rows[0]?.title !== entry.title) {
			lines.push(`  ${entry.title}`);
		}
		for (const row of entry.rows) {
			lines.push(line(row));
		}
	}
	for (const hidden of accounts.hiddenGroups) {
		lines.push("", hidden);
	}
	const kept = rows.filter((row) => row.section === "not-listed");
	if (kept.length > 0) {
		lines.push("", "Allowed but not listed now");
		for (const row of kept) {
			lines.push(
				`    ${number(row)} ${mark(row)} ${row.key} · ${rowNote(row, view)}`
			);
		}
	}
	return lines.join("\n");
}

const PICK_QUESTION =
	"\nToggle rows (e.g. 1 3-5), or type all, none, unlimited, save or cancel: ";

export async function pickCommand(
	ctx: CliContext,
	view: AgentIdentityView,
	args: AgentsArgs
): Promise<number> {
	if (ctx.flags.json) {
		throw new UsageError(
			`'pick' asks on the terminal. For scripts, use 'ryu-cli agents access ${view.id} available --json', then add or remove keys.`
		);
	}
	refuseRemotePeerChange(view, args.engine);
	requireEditable(view);
	const accounts = await loadAccountsFor(ctx, view, args.engine);
	const rows = accountPickerRows(accounts, view.accountAccess);
	let draft: string[] | null =
		view.accountAccess === null ? null : [...view.accountAccess];
	let show = true;
	for (;;) {
		if (show) {
			ctx.io.out(`${renderPickList(view, accounts, rows, draft)}\n`);
		}
		show = true;
		const answer = await ctx.promptLine(PICK_QUESTION);
		if (answer === null) {
			throw new Error(
				`Picking accounts needs an interactive terminal, and none answered. Nothing was saved. List them with 'ryu-cli agents access ${view.id} available', then use add or remove.`
			);
		}
		const command = parsePickCommand(answer, rows.length);
		switch (command.kind) {
			case "cancel":
				ctx.io.out("Nothing was saved.\n");
				return 0;
			case "save":
				if (sameAccountAccess(draft, view.accountAccess)) {
					ctx.io.out("Nothing changed, so nothing was saved.\n");
					return 0;
				}
				warnUnusedKeys(ctx, draft ?? [], view.identityMode);
				return saveAgentPatch(
					ctx,
					view,
					{ accountAccess: draft, engine: engineFlag(args) },
					draft === null
						? `'${view.name}' has no account limit now.`
						: `Saved '${view.name}''s account access.`
				);
			case "invalid":
				ctx.io.err(`${command.message}\n`);
				show = false;
				break;
			case "show":
				break;
			case "all": {
				const blocked =
					draft === null ? accountLimitStartBlocked(accounts) : null;
				if (blocked) {
					ctx.io.err(`${blocked}\n`);
					show = false;
					break;
				}
				draft = selectAllAccounts(draft ?? [], accounts);
				break;
			}
			case "none":
				draft = [];
				break;
			case "no-limit":
				draft = null;
				break;
			case "toggle": {
				const blocked =
					draft === null ? accountLimitStartBlocked(accounts) : null;
				if (blocked) {
					ctx.io.err(`${blocked}\n`);
					show = false;
					break;
				}
				if (draft === null) {
					ctx.io.out(
						"Limit turned on: every listed account starts allowed, so only what you untick is taken away. Accounts you connect later won't be added automatically.\n"
					);
				}
				for (const index of command.indexes) {
					const row = rows[index];
					if (row) {
						draft = toggleAccountAccess(draft, accounts, row.key);
					}
				}
				break;
			}
			default:
				break;
		}
	}
}
