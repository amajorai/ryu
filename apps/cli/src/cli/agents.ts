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
	addAccountKeys,
	identityModeDescription,
	identityModeLabel,
	isRemotePeerEngine,
	parseIdentityMode,
	removeAccountKeys,
} from "../core/agentIdentity.ts";
import { tf } from "../i18n/translate.ts";
import { NO_AGENT_CAPABILITIES } from "../surfaces/agents/capabilities.ts";
import {
	type AgentsArgs,
	MODES_HINT,
	parseAgentsArgs,
	USAGE,
} from "./agents-args.ts";
import {
	agentEnvelopeSchema,
	agentListSchema,
	coreCall,
	launchRefusal,
	loadAgent,
	toView,
	viewJson,
} from "./agents-core.ts";
import {
	describeAccess,
	describeAgent,
	describePendingIdentity,
	describeRemotePeer,
	output,
	refuseRemotePeerChange,
	requireId,
} from "./agents-output.ts";
import { availableCommand, pickCommand } from "./agents-picker.ts";
import {
	engineFlag,
	requireKeys,
	saveAgentPatch,
	warnUnusedKeys,
} from "./agents-save.ts";
import { formatTable } from "./output.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";

export { type AgentsArgs, parseAgentsArgs } from "./agents-args.ts";
export type { AgentIdentityView } from "./agents-core.ts";

// ── Subcommands ──────────────────────────────────────────────────────────────

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
				? tf(
						"'{name}' had no account limit; it is now limited to Treg and the {count, plural, one {account} other {accounts}} you added. Every other account it could use before is no longer allowed; add them with 'ryu-cli agents access {id} add <key>…', or run 'ryu-cli agents access {id} clear' to remove the limit.",
						{ count: keys.length, id: view.id, name: view.name }
					)
				: tf(
						"Added {length} {count, plural, one {account} other {accounts}} to '{name}'.",
						{
							count: keys.length,
							length: String(keys.length),
							name: view.name,
						}
					);
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
