// packages/services-cli/src/commands/managed-agents.ts
//
// `ryu-services managed-agents …`: Ryu Managed Agents (preview) commands.
//
//   agents list [--limit N] [--cursor C] [--include-archived] [--all]
//   environments list [--limit N] [--cursor C] [--include-archived] [--all]
//   sessions create --agent ID --environment ID [--message T] [--title T] [--follow] [--until turn|terminal]
//   sessions get <id>
//   sessions send <id> --text T [--follow] [--until turn|terminal]
//   sessions stream <id> [--after SEQ]
//   sessions pending-approvals <id>
//   sessions approve <id> <toolUseId> [--follow] [--until turn|terminal]
//   sessions deny <id> <toolUseId> [--message T] [--follow] [--until turn|terminal]
//
// Interactive tool approvals (anthropic sessions of agents with
// `requireApproval`): every follow (`create`, `send`, `approve` and `deny`
// with `--follow`) and `stream` print each `agent.tool_approval_request` as
// a JSON line like any event and also write the exact `approve` / `deny`
// commands to stderr. A follow stops at the `requires_action` idle; when it
// stops there with requests it did not print (opened before it started),
// it looks them up and prints their notes too. `approve` / `deny --follow`
// pick the turn up again from the answer. Nothing is answered for you.
//
// Configuration comes from RYU_API_KEY (+ RYU_ORGANIZATION_ID) and
// RYU_API_URL, or --api-key / --base-url. `ctx.ryu` already carries
// --idempotency-key and --timeout.

import type {
	ManagedAgentEvent,
	ManagedAgentFollowUntil,
} from "@ryuhq/services";
import { listPendingApprovals } from "@ryuhq/services/tools";
import {
	booleanFlag,
	CliUsageError,
	countFlag,
	requireStringFlag,
	stringFlag,
} from "../args.ts";
import { listPage, nextCursorOf } from "../list-output.ts";
import { DEFAULT_PROGRAM } from "../program.ts";
import type { CommandContext, ServiceCommand } from "../registry.ts";

function requireArg(ctx: CommandContext, name: string): string {
	const [value, ...extra] = ctx.args;
	if (value === undefined || value === "") {
		throw new CliUsageError(`<${name}> is required.`);
	}
	if (extra.length > 0) {
		throw new CliUsageError(
			`Unexpected arguments: ${extra.map((item) => JSON.stringify(item)).join(" ")}.`
		);
	}
	return value;
}

function requireArgs(ctx: CommandContext, names: readonly string[]): string[] {
	const values: string[] = [];
	for (const [index, name] of names.entries()) {
		const value = ctx.args[index];
		if (value === undefined || value === "") {
			throw new CliUsageError(`<${name}> is required.`);
		}
		values.push(value);
	}
	const extra = ctx.args.slice(names.length);
	if (extra.length > 0) {
		throw new CliUsageError(
			`Unexpected arguments: ${extra.map((item) => JSON.stringify(item)).join(" ")}.`
		);
	}
	return values;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"canceled",
]);

/**
 * The stderr note for an approval request: what waits, and the commands that
 * answer it. `program` is the command line that runs this CLI (`ryu-cli
 * services` when a host delegates); default `ryu-services`.
 */
export function approvalRequestNote(
	event: {
		expiresAt: string;
		name: string;
		server: string | null;
		sessionId: string;
		toolUseId: string;
	},
	program?: string
): string {
	const sessions = `${program?.trim() || DEFAULT_PROGRAM} managed-agents sessions`;
	const tool =
		event.server === null ? event.name : `${event.server}/${event.name}`;
	const ids = `${event.sessionId} ${event.toolUseId}`;
	return [
		`approval needed: ${tool} waits for your decision until ${event.expiresAt} (then Ryu denies it).`,
		`  allow: ${sessions} approve ${ids} --follow`,
		`  deny:  ${sessions} deny ${ids} --message "<reason shown to the model>" --follow`,
		"  (--follow keeps printing the turn after the answer; leave it out to answer only.)",
	].join("\n");
}

function rejectArgs(ctx: CommandContext): void {
	if (ctx.args.length > 0) {
		throw new CliUsageError(
			`Unexpected arguments: ${ctx.args.map((item) => JSON.stringify(item)).join(" ")}.`
		);
	}
}

function untilFlag(ctx: CommandContext): ManagedAgentFollowUntil {
	const value = stringFlag(ctx.flags, "until") ?? "turn";
	if (value !== "turn" && value !== "terminal") {
		throw new CliUsageError('--until must be "turn" or "terminal".');
	}
	return value;
}

function textMessage(text: string) {
	return {
		type: "user.message" as const,
		content: [{ type: "text" as const, text }],
	};
}

interface ManagedAgentsListQuery {
	cursor?: string;
	includeArchived?: true;
	limit?: number;
}

interface ManagedAgentsPage {
	readonly data: readonly unknown[];
	readonly nextCursor?: string | null;
}

/**
 * `agents list` and `environments list`: one page of a list route, newest
 * first, one JSON line per item with the next page's cursor on stderr;
 * `--all` streams every page.
 */
function listCommand(
	resource: "agents" | "environments",
	list: (
		ctx: CommandContext,
		query: ManagedAgentsListQuery
	) => PromiseLike<ManagedAgentsPage>,
	iterate: (
		ctx: CommandContext,
		query: Omit<ManagedAgentsListQuery, "cursor">
	) => AsyncIterable<unknown>
): ServiceCommand {
	return {
		path: [resource, "list"],
		summary:
			resource === "agents"
				? "List agents (one page, newest first: one JSON line each, the next page's cursor on stderr). --all reads every page."
				: "List environments (one page, newest first: one JSON line each, the next page's cursor on stderr), with the menv_ id sessions create takes. --all reads every page.",
		readOnly: true,
		flags: {
			limit: {
				type: "number",
				valueName: "n",
				description: "Page size, 1 to 100 (default 20).",
			},
			cursor: {
				type: "string",
				valueName: "cursor",
				description: "The nextCursor of the previous page.",
			},
			"include-archived": {
				type: "boolean",
				description: `Also list archived ${resource}.`,
			},
			all: {
				type: "boolean",
				description: `Page through every ${resource === "agents" ? "agent" : "environment"}, one JSON line each.`,
			},
		},
		run: (ctx) => {
			rejectArgs(ctx);
			const limit = countFlag(ctx.flags, "limit");
			const cursor = stringFlag(ctx.flags, "cursor");
			const filters = {
				...(limit === undefined ? {} : { limit }),
				...(booleanFlag(ctx.flags, "include-archived")
					? { includeArchived: true as const }
					: {}),
			};
			if (booleanFlag(ctx.flags, "all")) {
				if (cursor !== undefined) {
					throw new CliUsageError("--all and --cursor cannot be combined.");
				}
				return iterate(ctx, filters);
			}
			return listPage(
				ctx,
				list(ctx, cursor === undefined ? filters : { ...filters, cursor }),
				{
					noun: resource,
					items: (page) => page.data,
					next: (page) => {
						const next = nextCursorOf(page);
						return next === null
							? null
							: `More ${resource}: pass --cursor ${next} for the next page, or --all for every one.`;
					},
				}
			);
		},
	};
}

const listAgents = listCommand(
	"agents",
	(ctx, query) => ctx.ryu.managedAgents.agents.list(query),
	(ctx, query) => ctx.ryu.managedAgents.agents.iterate(query)
);

const listEnvironments = listCommand(
	"environments",
	(ctx, query) => ctx.ryu.managedAgents.environments.list(query),
	(ctx, query) => ctx.ryu.managedAgents.environments.iterate(query)
);

/**
 * Yields `events` and writes the approve/deny note to stderr for each
 * approval request among them. Returns the toolUseIds it noted and the last
 * event.
 */
async function* withApprovalNotes(
	ctx: CommandContext,
	events: AsyncIterable<ManagedAgentEvent>
): AsyncGenerator<
	ManagedAgentEvent,
	{ last: ManagedAgentEvent | null; noted: Set<string> }
> {
	const noted = new Set<string>();
	let last: ManagedAgentEvent | null = null;
	for await (const event of events) {
		yield event;
		last = event;
		if (event.type === "agent.tool_approval_request") {
			noted.add(event.toolUseId);
			ctx.io.stderr.write(`${approvalRequestNote(event, ctx.io.program)}\n`);
		}
	}
	return { last, noted };
}

/** Whether `event` leaves nothing to answer: a terminal status, or an idle that is not `requires_action`. */
function settledStop(event: ManagedAgentEvent): boolean {
	if (event.type !== "session.status") {
		return false;
	}
	if (TERMINAL_STATUSES.has(event.status)) {
		return true;
	}
	return event.status === "idle" && event.stopReason !== "requires_action";
}

/**
 * Follows `sessionId` like `sessions.follow()` and prints approval notes.
 * When the follow stopped anywhere but a settled status (it stops at an
 * approval nobody answered, which may have opened before `after`), looks the
 * open requests up and notes the ones it did not print.
 */
async function* followWithNotes(
	ctx: CommandContext,
	sessionId: string,
	options: { after?: number; headSeq?: number; until: ManagedAgentFollowUntil }
): AsyncGenerator<unknown> {
	const { last, noted } = yield* withApprovalNotes(
		ctx,
		ctx.ryu.managedAgents.sessions.follow(sessionId, options)
	);
	if (last !== null && settledStop(last)) {
		return;
	}
	const pending = await listPendingApprovals(ctx.ryu, sessionId);
	for (const request of pending.data) {
		if (!noted.has(request.toolUseId)) {
			ctx.io.stderr.write(
				`${approvalRequestNote({ ...request, sessionId }, ctx.io.program)}\n`
			);
		}
	}
}

async function* createAndFollow(
	ctx: CommandContext,
	input: Parameters<
		CommandContext["ryu"]["managedAgents"]["sessions"]["create"]
	>[0],
	until: ManagedAgentFollowUntil
): AsyncGenerator<unknown> {
	const session = await ctx.ryu.managedAgents.sessions.create(input);
	yield session;
	yield* followWithNotes(ctx, session.id, {
		headSeq: session.headSeq,
		until,
	});
}

/** The `--follow` / `--until` flags of the commands that can follow the turn. */
const FOLLOW_FLAGS = {
	follow: {
		type: "boolean",
		description:
			"Then print each event of the turn as one JSON line until it ends. A tool approval request also prints the approve/deny commands to stderr.",
	},
	until: {
		type: "string",
		valueName: "turn|terminal",
		description:
			'With --follow: stop when the turn ends ("turn", default) or when the session ends ("terminal"). Either stops at an approval request nobody answered.',
	},
} as const;

/** Whether to follow; `--until` without `--follow` is a usage error. */
function followMode(ctx: CommandContext): ManagedAgentFollowUntil | null {
	const until = untilFlag(ctx);
	if (booleanFlag(ctx.flags, "follow")) {
		return until;
	}
	if (stringFlag(ctx.flags, "until") !== undefined) {
		throw new CliUsageError("--until needs --follow.");
	}
	return null;
}

/**
 * Runs `append` (a write that returns appended events), then follows the
 * turn from just before the first appended event, so the follow prints the
 * appended events too.
 */
async function* appendAndFollow(
	ctx: CommandContext,
	sessionId: string,
	append: () => Promise<{ seq: number }[] | { seq: number }>,
	until: ManagedAgentFollowUntil
): AsyncGenerator<unknown> {
	const appended = await append();
	const first = Array.isArray(appended) ? appended[0] : appended;
	if (first === undefined) {
		return;
	}
	yield* followWithNotes(ctx, sessionId, { after: first.seq - 1, until });
}

const createSession: ServiceCommand = {
	path: ["sessions", "create"],
	summary:
		"Start a session; --message sends a first message, --follow streams events until the turn ends.",
	example:
		'ryu-services managed-agents sessions create --agent <magt_id> --environment <menv_id> --message "Hello" --follow',
	flags: {
		agent: {
			type: "string",
			valueName: "id",
			description: "Agent id (magt_…).",
			required: true,
		},
		environment: {
			type: "string",
			valueName: "id",
			description: "Environment id (menv_…).",
			required: true,
		},
		message: {
			type: "string",
			valueName: "text",
			description: "A first user message.",
		},
		title: { type: "string", valueName: "text", description: "Session title." },
		follow: {
			type: "boolean",
			description:
				"Print the session, then each event as one JSON line until the turn ends. A tool approval request also prints the approve/deny commands to stderr.",
		},
		until: {
			type: "string",
			valueName: "turn|terminal",
			description:
				'With --follow: stop when the turn ends ("turn", default) or when the session ends ("terminal").',
		},
	},
	run: (ctx) => {
		rejectArgs(ctx);
		const message = stringFlag(ctx.flags, "message");
		const title = stringFlag(ctx.flags, "title");
		const input = {
			agentId: requireStringFlag(ctx.flags, "agent"),
			environmentId: requireStringFlag(ctx.flags, "environment"),
			...(title === undefined ? {} : { title }),
			...(message === undefined
				? {}
				: { initialEvents: [textMessage(message)] }),
		};
		const until = followMode(ctx);
		if (until !== null) {
			return createAndFollow(ctx, input, until);
		}
		return ctx.ryu.managedAgents.sessions.create(input);
	},
};

const getSession: ServiceCommand = {
	path: ["sessions", "get"],
	usage: "<id>",
	summary: "Show a session.",
	readOnly: true,
	run: (ctx) => ctx.ryu.managedAgents.sessions.get(requireArg(ctx, "id")),
};

const sendMessage: ServiceCommand = {
	path: ["sessions", "send"],
	usage: "<id>",
	summary:
		"Send a user message to a session; --follow streams the turn's events until it ends.",
	flags: {
		text: {
			type: "string",
			valueName: "text",
			description: "The message text.",
			required: true,
		},
		...FOLLOW_FLAGS,
	},
	run: (ctx) => {
		const sessionId = requireArg(ctx, "id");
		const events = [textMessage(requireStringFlag(ctx.flags, "text"))];
		const until = followMode(ctx);
		if (until === null) {
			return ctx.ryu.managedAgents.sessions.send(sessionId, events);
		}
		return appendAndFollow(
			ctx,
			sessionId,
			() => ctx.ryu.managedAgents.sessions.send(sessionId, events),
			until
		);
	},
};

const streamSession: ServiceCommand = {
	path: ["sessions", "stream"],
	usage: "<id>",
	summary:
		"Stream a session's events as JSON lines until the session ends (reconnects on drops). Approval requests also print the approve/deny commands to stderr.",
	readOnly: true,
	flags: {
		after: {
			type: "number",
			valueName: "seq",
			description: "Start after this event seq (default 0, the whole log).",
		},
	},
	run: (ctx) => {
		const sessionId = requireArg(ctx, "id");
		const after = countFlag(ctx.flags, "after");
		return withApprovalNotes(
			ctx,
			ctx.ryu.managedAgents.sessions.stream(
				sessionId,
				after === undefined ? {} : { after }
			)
		);
	},
};

const pendingApprovals: ServiceCommand = {
	path: ["sessions", "pending-approvals"],
	usage: "<id>",
	summary:
		"List the tool calls waiting for approval, with each call's input and expiresAt.",
	readOnly: true,
	run: (ctx) =>
		listPage(ctx, listPendingApprovals(ctx.ryu, requireArg(ctx, "id")), {
			items: (page) => page.data,
			next: (page) =>
				page.complete
					? null
					: "More approvals may be pending: the scan stopped before reading every approval event. --json shows complete: false.",
			noun: "pending approvals",
		}),
};

function answerCommand(decision: "allow" | "deny"): ServiceCommand {
	const allow = decision === "allow";
	return {
		path: ["sessions", allow ? "approve" : "deny"],
		usage: "<id> <toolUseId>",
		summary: allow
			? "Allow a tool call waiting for approval (agent.tool_approval_request); --follow streams the rest of the turn."
			: "Deny a tool call waiting for approval; --message is shown to the model, --follow streams the rest of the turn.",
		flags: {
			...(allow
				? {}
				: {
						message: {
							type: "string",
							valueName: "text",
							description:
								"Why it was denied, shown to the model (at most 1,024 characters). A retry must repeat the same message: it is part of the derived idempotency key.",
						},
					}),
			...FOLLOW_FLAGS,
		},
		run: (ctx) => {
			const [sessionId = "", toolUseId = ""] = requireArgs(ctx, [
				"id",
				"toolUseId",
			]);
			const message = allow ? undefined : stringFlag(ctx.flags, "message");
			const options = message === undefined ? {} : { message };
			const sessions = ctx.ryu.managedAgents.sessions;
			const answer = () =>
				allow
					? sessions.approveTool(sessionId, toolUseId, options)
					: sessions.denyTool(sessionId, toolUseId, options);
			const until = followMode(ctx);
			return until === null
				? answer()
				: appendAndFollow(ctx, sessionId, answer, until);
		},
	};
}

const approveTool = answerCommand("allow");
const denyTool = answerCommand("deny");

/** Every `ryu-services managed-agents` command. */
export const managedAgentsCommands: readonly ServiceCommand[] = [
	listAgents,
	listEnvironments,
	createSession,
	getSession,
	sendMessage,
	streamSession,
	pendingApprovals,
	approveTool,
	denyTool,
];
