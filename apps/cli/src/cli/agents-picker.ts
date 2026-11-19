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
import { tf, tr, trMessage } from "../i18n/translate.ts";
import type { AgentsArgs } from "./agents-args.ts";
import { type AgentIdentityView, viewJson } from "./agents-core.ts";
import {
	describeRemotePeer,
	output,
	refuseRemotePeerChange,
	requireEditable,
} from "./agents-output.ts";
import { engineFlag, saveAgentPatch, warnUnusedKeys } from "./agents-save.ts";
import { localize } from "./localizedText.ts";
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
	const title = tr(row.title);
	return row.status ? `${title} (${tr(row.status)})` : title;
}

function rowNote(row: AvailableAccount, view: AgentIdentityView): string {
	if (row.section === "not-listed") {
		return [
			row.detail && tr(row.detail),
			accountKeyUnusedReason(row.key, view.identityMode),
		]
			.filter(Boolean)
			.join("; ");
	}
	return row.detail ? tr(row.detail) : "";
}

/** The lines under a section with no rows, or that failed to load. */
function sectionNotices(entry: AccountSection): string[] {
	if (entry.error) {
		return [trMessage(entry.error)];
	}
	return entry.rows.length === 0 && entry.empty ? [tr(entry.empty)] : [];
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

export function describeAvailable(
	view: AgentIdentityView,
	accounts: AvailableAccounts
): string {
	const lines = [
		tf("Accounts '{name}' can be allowed ({mode}).", {
			name: view.name,
			mode: identityModeLabel(view.identityMode),
		}),
		tf("Account access: {headline}", {
			headline: accountAccessHeadline(view.accountAccess),
		}),
		"",
	];
	const rows = accounts.sections.flatMap((entry) =>
		entry.rows.map((row) => [
			isAccountAllowed(view.accountAccess, row.key) ? tr("yes") : tr("no"),
			row.key,
			accountLabel(row),
			tr(entry.title),
			row.detail ? tr(row.detail) : "",
		])
	);
	const notListed = keysNotListed(view.accountAccess, accounts).map(
		notListedRow
	);
	for (const row of notListed) {
		rows.push([
			tr("yes"),
			row.key,
			tr(row.title),
			tr("Not listed now"),
			rowNote(row, view),
		]);
	}
	lines.push(
		formatTable(["ALLOWED", "KEY", "ACCOUNT", "SECTION", "DETAIL"], rows)
	);
	const notices = accounts.sections.flatMap((entry) =>
		sectionNotices(entry).map((text) => `  ${tr(entry.title)}: ${text}`)
	);
	if (notices.length > 0) {
		lines.push("", ...notices);
	}
	for (const hidden of accounts.hiddenGroups) {
		lines.push(`  ${tr(hidden)}`);
	}
	lines.push(
		"",
		tf(
			"Allow or remove one with: ryu-cli agents access {id} <add|remove> <key>…, or tick them with: ryu-cli agents access {id} pick",
			{ id: view.id }
		)
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
export function renderPickList(
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
		tf("Account access for '{name}' · {mode}", {
			name: view.name,
			mode: identityModeLabel(view.identityMode),
		}),
		`${accountAccessHeadline(draft)}. ${accountAccessNote(draft, view.identityMode)}`,
	];
	let owner: string | null = null;
	for (const entry of accounts.sections) {
		if (entry.owner !== owner) {
			owner = entry.owner;
			lines.push("", tr(ACCOUNT_OWNER_HEADINGS[entry.owner]));
		}
		// A section with nothing to tick is one line; one whose single row
		// carries its name (Treg, Control of your desktop) has no title.
		const notices = sectionNotices(entry);
		if (notices.length > 0) {
			lines.push(`  ${tr(entry.title)}: ${notices.join(" ")}`);
		} else if (entry.rows[0]?.title !== entry.title) {
			lines.push(`  ${tr(entry.title)}`);
		}
		for (const row of entry.rows) {
			lines.push(line(row));
		}
	}
	for (const hidden of accounts.hiddenGroups) {
		lines.push("", tr(hidden));
	}
	const kept = rows.filter((row) => row.section === "not-listed");
	if (kept.length > 0) {
		lines.push("", tr("Allowed but not listed now"));
		for (const row of kept) {
			lines.push(
				`    ${number(row)} ${mark(row)} ${row.key} · ${rowNote(row, view)}`
			);
		}
	}
	return lines.join("\n");
}

/** The picker's prompt. The words it parses stay English in every language. */
export function pickQuestion(): string {
	const question = tf(
		"Toggle rows (e.g. 1 3-5), or type {all}, {none}, {unlimited}, {save} or {cancel}:",
		{
			all: "all",
			cancel: "cancel",
			none: "none",
			save: "save",
			unlimited: "unlimited",
		}
	);
	return `\n${question} `;
}

export async function pickCommand(
	ctx: CliContext,
	view: AgentIdentityView,
	args: AgentsArgs
): Promise<number> {
	if (ctx.flags.json) {
		throw new UsageError(
			localize(
				"'pick' asks on the terminal. For scripts, use 'ryu-cli agents access {id} available --json', then add or remove keys.",
				{ id: view.id }
			)
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
		const answer = await ctx.promptLine(pickQuestion());
		if (answer === null) {
			throw new Error(
				`Picking accounts needs an interactive terminal, and none answered. Nothing was saved. List them with 'ryu-cli agents access ${view.id} available', then use add or remove.`
			);
		}
		const command = parsePickCommand(answer, rows.length);
		switch (command.kind) {
			case "cancel":
				ctx.io.out(`${tr("Nothing was saved.")}\n`);
				return 0;
			case "save":
				if (sameAccountAccess(draft, view.accountAccess)) {
					ctx.io.out(`${tr("Nothing changed, so nothing was saved.")}\n`);
					return 0;
				}
				warnUnusedKeys(ctx, draft ?? [], view.identityMode);
				return saveAgentPatch(
					ctx,
					view,
					{ accountAccess: draft, engine: engineFlag(args) },
					draft === null
						? tf("'{name}' has no account limit now.", { name: view.name })
						: tf("Saved '{name}''s account access.", { name: view.name })
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
					const notice = tr(
						"Limit turned on: every listed account starts allowed, so only what you untick is taken away. Accounts you connect later won't be added automatically."
					);
					ctx.io.out(`${notice}\n`);
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
