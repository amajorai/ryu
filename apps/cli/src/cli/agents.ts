// `ryu-cli agents …` — how an agent works and whose accounts it may use.
//
//   agents [list]                          GET  /api/agents
//   agents show <id>                       GET  /api/agents/:id
//   agents create <name> [--identity <m>]  POST /api/agents
//   agents identity <id> [<mode>|dismiss]  GET, then PUT /api/agents/:id { identity_mode }
//   agents access <id> [list|add|remove|clear|none] [key…]
//                                          GET, then PUT /api/agents/:id { account_access }
//   agents access <id> available           the accounts it could be allowed, with labels
//   agents access <id> pick                tick them on the terminal, then PUT as above
//
// `available` and `pick` list the accounts from the same Core endpoints the
// desktop editor reads (see src/core/agentAccountCatalog.ts).
//
// Core's PUT is a patch: only the fields sent change, and `account_access: null`
// clears the allowlist to "no limit". Every change carries the `updated_at` it
// read as `expected_updated_at`, so a save made elsewhere in between is refused
// (409) instead of overwritten. Before a change is saved, Core's launch check
// (`POST /api/agents/launch-check`, the same checks the agent's first turn runs)
// is asked whether the engine would still start; when it would not, nothing is
// saved, as the desktop editor keeps Save disabled. A check that cannot be made
// does not block the save, also as on desktop: Core still refuses at launch.

import {
	type AgentIdentityMode,
	agentIdentityMode,
	agentLaunchCheckResponseSchema,
	encodeAgentPathId,
	toAgentLaunchCheck,
	toAgentLaunchCheckBody,
} from "@ryuhq/core-client/agents";
import { ApiError } from "@ryuhq/core-client/client";
import { z } from "zod";
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
	ACCOUNT_KEY_FORMATS,
	accountAccessHeadline,
	accountAccessNote,
	accountKeyKind,
	accountKeyUnusedReason,
	addAccountKeys,
	identityModeDescription,
	identityModeLabel,
	isRemotePeerEngine,
	parseAccountKeys,
	parseIdentityMode,
	REMOTE_PEER_IDENTITY_NOTE,
	RYU_ENGINE_ID,
	removeAccountKeys,
} from "../core/agentIdentity.ts";
import { NO_AGENT_CAPABILITIES } from "../surfaces/agents/capabilities.ts";
import { formatTable } from "./output.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";

const USAGE = [
	"ryu-cli agents [list]",
	"ryu-cli agents show <id>",
	"ryu-cli agents create <name> [--identity managed|individual|mixed] [--engine <id>] [--model <id>]",
	"ryu-cli agents identity <id> [managed|individual|mixed|dismiss] [--engine <id>]",
	"ryu-cli agents access <id> [list | available | pick | add <key>… | remove <key>… | clear | none] [--engine <id>]",
].join("\n       ");
const MODES_HINT =
	"managed (Acts as you), individual (Its own identity), mixed (Both)";

// ── Arguments ────────────────────────────────────────────────────────────────

/** Global flags the dispatcher already applied; skipped here (with their value). */
const GLOBAL_VALUE_FLAGS = new Set([
	"--agent",
	"--file",
	"-f",
	"--kind",
	"--node",
	"--template",
]);
const GLOBAL_BOOLEAN_FLAGS = new Set([
	"--json",
	"--force",
	"--cascade",
	"--dry-run",
	"--fix",
	"--include-secrets",
	"-h",
	"--help",
	"--version",
]);
type AgentsValueFlag = "engine" | "identity" | "model";
const AGENTS_VALUE_FLAGS = new Map<string, AgentsValueFlag>([
	["--engine", "engine"],
	["--identity", "identity"],
	["--model", "model"],
]);

export interface AgentsArgs {
	engine: string | null;
	identity: string | null;
	model: string | null;
	positional: string[];
}

/**
 * Parse the raw tokens after `agents`. The command's own value flags are read
 * here because the dispatcher would otherwise leave their values among the
 * positional args. An unknown flag is a usage error rather than ignored, so a
 * typo such as `--mode individual` can never be taken for something else.
 */
export function parseAgentsArgs(raw: readonly string[]): AgentsArgs {
	const parsed: AgentsArgs = {
		engine: null,
		identity: null,
		model: null,
		positional: [],
	};
	for (let i = 0; i < raw.length; i += 1) {
		const token = raw[i] ?? "";
		if (token === "--") {
			parsed.positional.push(...raw.slice(i + 1));
			break;
		}
		if (!token.startsWith("-") || token === "-") {
			parsed.positional.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq === -1 ? token : token.slice(0, eq);
		if (GLOBAL_BOOLEAN_FLAGS.has(name)) {
			continue;
		}
		if (GLOBAL_VALUE_FLAGS.has(name)) {
			if (eq === -1) {
				i += 1;
			}
			continue;
		}
		const key = AGENTS_VALUE_FLAGS.get(name);
		if (!key) {
			throw new UsageError(`Unknown option '${name}'.\nUsage: ${USAGE}`);
		}
		const value = eq === -1 ? raw[i + 1] : token.slice(eq + 1);
		if (eq === -1) {
			i += 1;
		}
		if (value === undefined || value.trim() === "") {
			throw new UsageError(`${name} needs a value.\nUsage: ${USAGE}`);
		}
		parsed[key] = value.trim();
	}
	return parsed;
}

// ── Core records ─────────────────────────────────────────────────────────────

const agentRecordSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	engine: z.string().nullish(),
	identity_mode: z.string().nullish(),
	account_access: z.array(z.string()).nullable().optional(),
	locked: z.boolean().optional(),
	updated_at: z.string().nullish(),
});
const agentEnvelopeSchema = z.looseObject({
	agent: agentRecordSchema,
	// `GET /api/agents/:id` only: where an app's agent got its mode.
	app_identity: z
		.looseObject({ pending_mode: z.string().nullish() })
		.nullish()
		.catch(null),
});
const agentListSchema = z.looseObject({
	agents: z
		.array(
			z.looseObject({
				id: z.string(),
				name: z.string(),
				engine: z.string().nullish(),
				transport: z.string().nullish(),
			})
		)
		.optional(),
});

export interface AgentIdentityView {
	accountAccess: string[] | null;
	engine: string | null;
	id: string;
	identityMode: AgentIdentityMode;
	locked: boolean;
	name: string;
	/** A mode a newer version of the agent's app asked for, left for the user. */
	pendingIdentityMode: AgentIdentityMode | null;
	updatedAt: string | null;
}

function toView(
	record: z.output<typeof agentRecordSchema>,
	appIdentity?: { pending_mode?: string | null } | null
): AgentIdentityView {
	const pending = appIdentity?.pending_mode;
	return {
		// An unknown requested mode reads as `individual`; it is only a request.
		pendingIdentityMode: pending ? agentIdentityMode(pending) : null,
		id: record.id,
		name: record.name,
		engine: record.engine ?? null,
		// Missing → managed (a record from before identity modes); unknown →
		// individual, the narrowest, so nothing here can widen it.
		identityMode: agentIdentityMode(record.identity_mode),
		accountAccess: record.account_access ?? null,
		locked: record.locked ?? false,
		updatedAt: record.updated_at ?? null,
	};
}

function viewJson(view: AgentIdentityView) {
	return {
		id: view.id,
		name: view.name,
		engine: view.engine,
		identity_mode: view.identityMode,
		account_access: view.accountAccess,
		...(view.pendingIdentityMode
			? { pending_identity_mode: view.pendingIdentityMode }
			: {}),
	};
}

/** Core's own words for a refused request, instead of "… failed: 409". */
function coreError(error: unknown, agentId: string | null): Error {
	if (!(error instanceof ApiError)) {
		return error instanceof Error ? error : new Error(String(error));
	}
	if (error.status === 409 && error.serverMessage?.includes("revision")) {
		return new Error(
			`Agent '${agentId}' was changed by someone else while this command ran. Nothing was saved; run it again.`
		);
	}
	if (error.status === 404) {
		return new Error(`Agent '${agentId}' was not found.`);
	}
	return new Error(error.serverMessage ?? error.message);
}

async function coreCall(
	ctx: CliContext,
	path: string,
	options: { body?: unknown; method: string },
	agentId: string | null
) {
	if (!ctx.api.call) {
		throw new Error("This command requires the live Core client.");
	}
	try {
		return await ctx.api.call(ctx.target, path, {
			method: options.method,
			body: options.body,
		});
	} catch (error) {
		throw coreError(error, agentId);
	}
}

async function loadAgent(
	ctx: CliContext,
	id: string
): Promise<AgentIdentityView> {
	const json = await coreCall(
		ctx,
		`/api/agents/${encodeAgentPathId(id)}`,
		{ method: "GET" },
		id
	);
	const parsed = agentEnvelopeSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error(`Core returned an unreadable record for agent '${id}'.`);
	}
	return toView(parsed.data.agent, parsed.data.app_identity);
}

/**
 * Ask Core whether the engine would start. Returns Core's refusal, or null when
 * it would start or the check could not be made (reported on stderr).
 */
async function launchRefusal(
	ctx: CliContext,
	input: {
		accountAccess: string[] | null;
		agentId: string | null;
		engine: string | null;
		identityMode: AgentIdentityMode;
	}
): Promise<string | null> {
	if (!input.engine) {
		return null;
	}
	if (!ctx.api.call) {
		throw new Error("This command requires the live Core client.");
	}
	let json: unknown;
	try {
		// Called directly, not through coreCall: a 404 here means this Core
		// has no launch check, not that the agent is missing.
		json = await ctx.api.call(ctx.target, "/api/agents/launch-check", {
			method: "POST",
			body: toAgentLaunchCheckBody({ ...input, engine: input.engine }),
		});
	} catch (error) {
		const detail =
			error instanceof ApiError && error.status === 404
				? "this Core has no launch check"
				: coreError(error, input.agentId).message;
		ctx.io.err(
			`Note: could not ask Core whether the engine will start (${detail}). Saving anyway; Core still checks when the agent starts.\n`
		);
		return null;
	}
	const parsed = agentLaunchCheckResponseSchema.safeParse(json);
	if (!parsed.success) {
		ctx.io.err(
			"Note: Core's launch check gave an unreadable answer. Saving anyway; Core still checks when the agent starts.\n"
		);
		return null;
	}
	const check = toAgentLaunchCheck(parsed.data);
	if (check.modelWarning) {
		ctx.io.err(`Warning: ${check.modelWarning}\n`);
	}
	if (check.launchable) {
		return null;
	}
	const reason =
		check.reason ?? "Core says this agent's engine would not start.";
	const hint =
		input.engine === RYU_ENGINE_ID
			? ""
			: ` To run it on Ryu instead, add --engine ${RYU_ENGINE_ID}.`;
	return `${reason} Nothing was saved.${hint}`;
}

// ── Output ───────────────────────────────────────────────────────────────────

function describeAccess(view: AgentIdentityView): string[] {
	const lines = [
		`Account access: ${accountAccessHeadline(view.accountAccess)}`,
	];
	lines.push(
		`                ${accountAccessNote(view.accountAccess, view.identityMode)}`
	);
	if (view.accountAccess && view.accountAccess.length > 0) {
		const rows = view.accountAccess.map((key) => [
			key,
			accountKeyKind(key)?.label ?? "Other",
			accountKeyUnusedReason(key, view.identityMode) ?? "",
		]);
		const table = formatTable(["KEY", "KIND", "NOTE"], rows);
		lines.push("", ...table.split("\n").map((line) => `  ${line}`));
	}
	return lines;
}

/** The lines that show an app's pending identity request, if there is one. */
function describePendingIdentity(view: AgentIdentityView): string[] {
	if (!view.pendingIdentityMode) {
		return [];
	}
	return [
		`App request:    ${identityModeLabel(view.pendingIdentityMode)}. A newer version of this agent's app asks for it; nothing changes until you choose.`,
		`                Accept: ryu-cli agents identity ${view.id} ${view.pendingIdentityMode}`,
		`                Dismiss and keep ${identityModeLabel(view.identityMode)}: ryu-cli agents identity ${view.id} dismiss`,
	];
}

function describeRemotePeer(): string[] {
	return [
		`How it works:   ${REMOTE_PEER_IDENTITY_NOTE.title}`,
		`                ${REMOTE_PEER_IDENTITY_NOTE.description}`,
	];
}

function describeAgent(view: AgentIdentityView): string {
	if (isRemotePeerEngine(view.engine)) {
		return [
			`Agent:          ${view.name} (${view.id})`,
			`Engine:         ${view.engine ?? "—"}`,
			...describeRemotePeer(),
		].join("\n");
	}
	return [
		`Agent:          ${view.name} (${view.id})`,
		`Engine:         ${view.engine ?? "—"}`,
		`How it works:   ${identityModeLabel(view.identityMode)}`,
		`                ${identityModeDescription(view.identityMode)}`,
		...describePendingIdentity(view),
		...describeAccess(view),
	].join("\n");
}

function output(ctx: CliContext, json: unknown, human: string): void {
	ctx.io.out(
		ctx.flags.json ? `${JSON.stringify(json, null, 2)}\n` : `${human}\n`
	);
}

// ── Subcommands ──────────────────────────────────────────────────────────────

function requireId(id: string | undefined, usage: string): string {
	if (!id) {
		throw new UsageError(`Usage: ${usage}`);
	}
	return id;
}

/**
 * A remote A2A peer has no identity or account access to change here: Core
 * ignores both for it, so a change would only look like it did something.
 * Moving it to another engine with `--engine` is allowed.
 */
function refuseRemotePeerChange(
	view: AgentIdentityView,
	engine: string | null
): void {
	if (isRemotePeerEngine(engine ?? view.engine)) {
		throw new Error(
			`'${view.name}' ${REMOTE_PEER_IDENTITY_NOTE.title.toLowerCase()}. ${REMOTE_PEER_IDENTITY_NOTE.description} Nothing was saved.`
		);
	}
}

function requireEditable(view: AgentIdentityView): void {
	if (view.locked) {
		throw new Error(
			`Agent '${view.id}' is locked. Unlock it before changing how it works or its account access.`
		);
	}
}

async function listAgents(ctx: CliContext): Promise<number> {
	const json = await coreCall(ctx, "/api/agents", { method: "GET" }, null);
	const agents = agentListSchema.parse(json).agents ?? [];
	if (ctx.flags.json) {
		ctx.io.out(`${JSON.stringify({ agents }, null, 2)}\n`);
		return 0;
	}
	if (agents.length === 0) {
		ctx.io.out("No agents.\n");
		return 0;
	}
	const rows = agents.map((agent) => [
		agent.id,
		agent.name,
		agent.engine ?? "—",
	]);
	ctx.io.out(`${formatTable(["ID", "NAME", "ENGINE"], rows)}\n`);
	ctx.io.out(
		"\nRun 'ryu-cli agents show <id>' for how an agent works and its account access.\n"
	);
	return 0;
}

async function showAgent(ctx: CliContext, args: AgentsArgs): Promise<number> {
	const id = requireId(args.positional[1], "ryu-cli agents show <id>");
	const view = await loadAgent(ctx, id);
	output(ctx, viewJson(view), describeAgent(view));
	return 0;
}

async function createAgentCommand(
	ctx: CliContext,
	args: AgentsArgs
): Promise<number> {
	const name = args.positional.slice(1).join(" ").trim();
	if (!name) {
		throw new UsageError(
			"Usage: ryu-cli agents create <name> [--identity managed|individual|mixed] [--engine <id>] [--model <id>]"
		);
	}
	// "Acts as you" is preselected on desktop and is Core's default.
	const identityMode =
		args.identity === null ? "managed" : parseIdentityMode(args.identity);
	if (!identityMode) {
		throw new UsageError(
			`Unknown identity '${args.identity}'. Choose ${MODES_HINT}.`
		);
	}
	const refusal = await launchRefusal(ctx, {
		accountAccess: null,
		agentId: null,
		engine: args.engine,
		identityMode,
	});
	if (refusal) {
		throw new Error(refusal);
	}
	// Same shape as the desktop New agent dialog: no tools until granted, and
	// account access left unset (no limit within the mode) until narrowed.
	const body = {
		name,
		identity_mode: identityMode,
		engine: args.engine,
		model: args.model,
		tools: [NO_AGENT_CAPABILITIES],
	};
	if (ctx.flags.dryRun) {
		output(
			ctx,
			{ dry_run: true, request: body },
			`Would create '${name}': ${identityModeLabel(identityMode)}, account access: no limit. Nothing was saved (--dry-run).`
		);
		return 0;
	}
	const json = await coreCall(
		ctx,
		"/api/agents",
		{ method: "POST", body },
		null
	);
	const parsed = agentEnvelopeSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error(
			"Core created the agent but returned an unreadable record."
		);
	}
	const view = toView(parsed.data.agent);
	output(ctx, viewJson(view), `Created agent.\n${describeAgent(view)}`);
	return 0;
}

interface AgentPatch {
	accountAccess?: string[] | null;
	/** Dismiss the identity mode the agent's app asked for. */
	dismissPendingIdentityMode?: true;
	engine?: string;
	identityMode?: AgentIdentityMode;
}

/** Launch-check, then PUT only the patched fields with the revision guard. */
async function saveAgentPatch(
	ctx: CliContext,
	view: AgentIdentityView,
	patch: AgentPatch,
	summary: string
): Promise<number> {
	requireEditable(view);
	const identityMode = patch.identityMode ?? view.identityMode;
	const accountAccess =
		patch.accountAccess === undefined
			? view.accountAccess
			: patch.accountAccess;
	const engine = patch.engine ?? view.engine;
	const refusal = await launchRefusal(ctx, {
		accountAccess,
		agentId: view.id,
		engine,
		identityMode,
	});
	if (refusal) {
		throw new Error(refusal);
	}
	const body: Record<string, unknown> = {};
	if (patch.identityMode !== undefined) {
		body.identity_mode = patch.identityMode;
	}
	if (patch.accountAccess !== undefined) {
		// `null` is meaningful: it clears the allowlist to "no limit".
		body.account_access = patch.accountAccess;
	}
	if (patch.engine !== undefined) {
		body.engine = patch.engine;
	}
	if (patch.dismissPendingIdentityMode) {
		body.dismiss_pending_identity_mode = true;
	}
	if (view.updatedAt) {
		body.expected_updated_at = view.updatedAt;
	}
	if (ctx.flags.dryRun) {
		const preview: AgentIdentityView = {
			...view,
			accountAccess,
			engine,
			identityMode,
		};
		output(
			ctx,
			{ dry_run: true, request: body, agent: viewJson(preview) },
			`${summary} Nothing was saved (--dry-run).\n${describeAgent(preview)}`
		);
		return 0;
	}
	const json = await coreCall(
		ctx,
		`/api/agents/${encodeAgentPathId(view.id)}`,
		{ method: "PUT", body },
		view.id
	);
	const parsed = agentEnvelopeSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error(
			`Core saved agent '${view.id}' but returned an unreadable record.`
		);
	}
	// The PUT answer carries no app request: saving the requested mode or
	// dismissing settles it, and any other save leaves it as it was.
	const settled =
		patch.dismissPendingIdentityMode === true ||
		(patch.identityMode !== undefined &&
			patch.identityMode === view.pendingIdentityMode);
	const saved = {
		...toView(parsed.data.agent),
		pendingIdentityMode: settled ? null : view.pendingIdentityMode,
	};
	output(ctx, viewJson(saved), `${summary}\n${describeAgent(saved)}`);
	return 0;
}

function engineFlag(args: AgentsArgs): string | undefined {
	return args.engine ?? undefined;
}

async function identityCommand(
	ctx: CliContext,
	args: AgentsArgs
): Promise<number> {
	const usage =
		"ryu-cli agents identity <id> [managed|individual|mixed|dismiss] [--engine <id>]";
	const id = requireId(args.positional[1], usage);
	const requested = args.positional[2] ?? args.identity;
	const view = await loadAgent(ctx, id);
	if (
		(requested === undefined || requested === null) &&
		isRemotePeerEngine(view.engine)
	) {
		output(ctx, viewJson(view), describeRemotePeer().join("\n"));
		return 0;
	}
	if (requested === undefined || requested === null) {
		output(
			ctx,
			viewJson(view),
			[
				`How it works:   ${identityModeLabel(view.identityMode)}`,
				`                ${identityModeDescription(view.identityMode)}`,
				...describePendingIdentity(view),
				"",
				`Change it with: ryu-cli agents identity ${view.id} <managed|individual|mixed>`,
			].join("\n")
		);
		return 0;
	}
	if (requested.trim().toLowerCase() === "dismiss") {
		if (!view.pendingIdentityMode) {
			throw new Error(
				`'${view.name}' has no identity request from its app to dismiss.`
			);
		}
		return saveAgentPatch(
			ctx,
			view,
			{ dismissPendingIdentityMode: true, engine: engineFlag(args) },
			`Dismissed the app's request. '${view.name}' keeps working as: ${identityModeLabel(view.identityMode)}.`
		);
	}
	const mode = parseIdentityMode(requested);
	if (!mode) {
		throw new UsageError(
			`Unknown identity '${requested}'. Choose ${MODES_HINT}.`
		);
	}
	refuseRemotePeerChange(view, args.engine);
	return saveAgentPatch(
		ctx,
		view,
		{ identityMode: mode, engine: engineFlag(args) },
		`'${view.name}' now works as: ${identityModeLabel(mode)}.`
	);
}

function requireKeys(raw: string[], usage: string): string[] {
	if (raw.length === 0) {
		throw new UsageError(`Usage: ${usage}`);
	}
	const { keys, invalid } = parseAccountKeys(raw);
	if (invalid.length > 0) {
		throw new UsageError(
			`Not an account key Core accepts: ${invalid.join(", ")}. Nothing was saved.\nKeys look like:\n  ${ACCOUNT_KEY_FORMATS.join("\n  ")}`
		);
	}
	return keys;
}

function warnUnusedKeys(
	ctx: CliContext,
	keys: readonly string[],
	mode: AgentIdentityMode
): void {
	for (const key of keys) {
		const reason = accountKeyUnusedReason(key, mode);
		if (reason) {
			ctx.io.err(`Note: ${key} is saved but ${reason}.\n`);
		}
	}
}

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

async function availableCommand(
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

async function pickCommand(
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

async function accessCommand(
	ctx: CliContext,
	args: AgentsArgs
): Promise<number> {
	const usage =
		"ryu-cli agents access <id> [list | available | pick | add <key>… | remove <key>… | clear | none] [--engine <id>]";
	const id = requireId(args.positional[1], usage);
	const action = args.positional[2] ?? "list";
	const rest = args.positional.slice(3);
	if (
		![
			"list",
			"ls",
			"available",
			"pick",
			"add",
			"remove",
			"rm",
			"clear",
			"none",
		].includes(action)
	) {
		throw new UsageError(`Usage: ${usage}`);
	}
	const view = await loadAgent(ctx, id);
	if (action === "available") {
		return availableCommand(ctx, view, args);
	}
	if (action === "pick") {
		return pickCommand(ctx, view, args);
	}
	if (
		(action === "list" || action === "ls") &&
		isRemotePeerEngine(view.engine)
	) {
		output(ctx, viewJson(view), describeRemotePeer().join("\n"));
		return 0;
	}
	if (action === "list" || action === "ls") {
		output(
			ctx,
			viewJson(view),
			[
				...describeAccess(view),
				"",
				`Change it with: ryu-cli agents access ${view.id} <add|remove> <key>…, clear (no limit) or none (no accounts)`,
			].join("\n")
		);
		return 0;
	}
	refuseRemotePeerChange(view, args.engine);
	if (action === "clear") {
		return saveAgentPatch(
			ctx,
			view,
			{ accountAccess: null, engine: engineFlag(args) },
			`'${view.name}' has no account limit now.`
		);
	}
	if (action === "none") {
		return saveAgentPatch(
			ctx,
			view,
			{ accountAccess: [], engine: engineFlag(args) },
			`'${view.name}' can't use any accounts now.`
		);
	}
	if (action === "add") {
		const keys = requireKeys(rest, `ryu-cli agents access ${id} add <key>…`);
		warnUnusedKeys(ctx, keys, view.identityMode);
		const next = addAccountKeys(view.accountAccess, keys);
		const summary =
			view.accountAccess === null
				? `'${view.name}' had no account limit; it is now limited to Treg and the ${keys.length === 1 ? "account" : "accounts"} you added. Every other account it could use before is no longer allowed; add them with 'ryu-cli agents access ${view.id} add <key>…', or run 'ryu-cli agents access ${view.id} clear' to remove the limit.`
				: `Added ${keys.length} ${keys.length === 1 ? "account" : "accounts"} to '${view.name}'.`;
		return saveAgentPatch(
			ctx,
			view,
			{ accountAccess: next, engine: engineFlag(args) },
			summary
		);
	}
	const keys = requireKeys(rest, `ryu-cli agents access ${id} remove <key>…`);
	if (view.accountAccess === null) {
		throw new Error(
			`'${view.name}' has no account limit, so there is nothing to remove. Use 'ryu-cli agents access ${view.id} add <key>…' to limit it to chosen accounts, or 'none' for no accounts.`
		);
	}
	const missing = keys.filter((key) => !view.accountAccess?.includes(key));
	if (missing.length > 0) {
		throw new Error(
			`Not in '${view.name}''s account access: ${missing.join(", ")}. Nothing was saved.`
		);
	}
	return saveAgentPatch(
		ctx,
		view,
		{
			accountAccess: removeAccountKeys(view.accountAccess, keys),
			engine: engineFlag(args),
		},
		`Removed ${keys.length} ${keys.length === 1 ? "account" : "accounts"} from '${view.name}'.`
	);
}

export const agentsCommand: Command = {
	name: "agents",
	aliases: ["agent"],
	summary: "Show or set how an agent works and its account access",
	usage: "ryu-cli agents <list|show|create|identity|access> …",
	run: async (ctx) => {
		const args = parseAgentsArgs(ctx.rawArgs);
		const sub = args.positional[0] ?? "list";
		switch (sub) {
			case "list":
			case "ls":
				return await listAgents(ctx);
			case "show":
				return await showAgent(ctx, args);
			case "create":
			case "new":
				return await createAgentCommand(ctx, args);
			case "identity":
				return await identityCommand(ctx, args);
			case "access":
				return await accessCommand(ctx, args);
			default:
				throw new UsageError(`Usage: ${USAGE}`);
		}
	},
};
