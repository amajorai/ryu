// `ryu-cli connect …`: browse Ryu's tool catalog and find, describe, request and
// call tools through a Ryu Connect deployment (Treg parity B12), over the
// typed client in `connectClient.ts`.
//
// Configuration comes from the environment so the key never appears on a
// command line: `RYU_CONNECT_URL` (or `--url`) and `RYU_CONNECT_KEY`. Browsing
// needs no key; it reads the control plane's anonymous catalog at
// `RYU_TOOL_CATALOG_URL`, else `<RYU_CONTROL_PLANE_URL or RYU_SERVER_URL or
// https://api.ryuhq.com>/api/tool-catalog` (the same default Core uses).

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	type ConnectArgs,
	integer,
	parseConnectArgs,
	VALUE_FLAGS,
} from "./connect-args.ts";
import { CONNECT_USAGE, renderConnectHelp } from "./connect-help.ts";
import { refusal } from "./connect-refusal.ts";
import {
	renderBalance,
	renderDescribe,
	renderIndex,
	renderPlatform,
	renderReceipt,
	renderSearch,
	renderStatus,
} from "./connect-render.ts";
import {
	type CallAnswer,
	CatalogClient,
	ConnectClient,
	ConnectError,
} from "./connectClient.ts";
import { localize } from "./localizedText.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";
import { VERSION } from "./version.ts";

export { type ConnectArgs, parseConnectArgs } from "./connect-args.ts";
export { formatCatalogCost } from "./connect-render.ts";

const USAGE = CONNECT_USAGE;

function connectClient(ctx: CliContext, args: ConnectArgs): ConnectClient {
	const url = args.values.url ?? ctx.env.RYU_CONNECT_URL?.trim();
	if (!url) {
		throw new UsageError(
			"Set RYU_CONNECT_URL (or pass --url) to your Connect deployment."
		);
	}
	return new ConnectClient(url, ctx.env.RYU_CONNECT_KEY, {
		userAgent: `ryu-cli/${VERSION}`,
	});
}

export function catalogUrl(
	env: Record<string, string | undefined>,
	flag?: string
): string {
	const explicit = flag ?? env.RYU_TOOL_CATALOG_URL?.trim();
	if (explicit === "off") {
		throw new UsageError(
			localize("The Ryu tool catalog is turned off ({setting}).", {
				setting: "RYU_TOOL_CATALOG_URL=off",
			})
		);
	}
	if (explicit) {
		return explicit;
	}
	const controlPlane =
		env.RYU_CONTROL_PLANE_URL?.trim() ||
		env.RYU_SERVER_URL?.trim() ||
		"https://api.ryuhq.com";
	return `${controlPlane.replace(/\/+$/u, "")}/api/tool-catalog`;
}

function catalogClient(ctx: CliContext, args: ConnectArgs): CatalogClient {
	const url = catalogUrl(ctx.env, args.values.catalogUrl);
	return new CatalogClient(url);
}

function printJson(ctx: CliContext, value: unknown): void {
	ctx.io.out(`${JSON.stringify(value, null, 2)}\n`);
}

async function status(ctx: CliContext, args: ConnectArgs): Promise<number> {
	const client = connectClient(ctx, args);
	const health = await client.health();
	const balance = client.hasKey ? await client.balance() : null;
	const catalog = (() => {
		try {
			return catalogUrl(ctx.env, args.values.catalogUrl);
		} catch {
			return null;
		}
	})();
	if (ctx.flags.json) {
		printJson(ctx, {
			url: client.origin,
			service: health.service,
			version: health.version ?? null,
			key: client.hasKey,
			balance,
			catalog,
		});
		return 0;
	}
	const view = {
		balance,
		catalog,
		hasKey: client.hasKey,
		health,
		origin: client.origin,
	};
	ctx.io.out(`${renderStatus(view)}\n`);
	return 0;
}

async function browse(ctx: CliContext, args: ConnectArgs): Promise<number> {
	const client = catalogClient(ctx, args);
	const slug = args.positional[1];
	if (slug) {
		const detail = await client.platform(slug);
		if (ctx.flags.json) {
			printJson(ctx, detail);
		} else {
			ctx.io.out(`${renderPlatform(detail)}\n`);
		}
		return 0;
	}
	const index = await client.platforms();
	if (ctx.flags.json) {
		printJson(ctx, index);
	} else {
		ctx.io.out(`${renderIndex(index)}\n`);
	}
	return 0;
}

async function search(ctx: CliContext, args: ConnectArgs): Promise<number> {
	const query = args.positional.slice(1).join(" ").trim();
	if (!query) {
		throw new UsageError("Usage: ryu-cli connect search <words…>");
	}
	const kind = args.values.kind;
	if (kind !== undefined && !["any", "composio", "mcp"].includes(kind)) {
		throw new UsageError("--kind must be any, composio or mcp.");
	}
	const result = await connectClient(ctx, args).search(query, {
		limit: integer(args.values.limit, "--limit", 1, 25),
		kind: kind as "any" | "composio" | "mcp" | undefined,
	});
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	ctx.io.out(`${renderSearch(result)}\n`);
	return 0;
}

async function describe(ctx: CliContext, args: ConnectArgs): Promise<number> {
	const id = args.positional[1];
	if (!id) {
		throw new UsageError("Usage: ryu-cli connect describe <id>");
	}
	const tool = await connectClient(ctx, args).describe(id);
	if (ctx.flags.json) {
		printJson(ctx, tool);
		return 0;
	}
	ctx.io.out(`${renderDescribe(tool)}\n`);
	return 0;
}

async function request(ctx: CliContext, args: ConnectArgs): Promise<number> {
	const description = args.positional.slice(1).join(" ").trim();
	if (!description) {
		throw new UsageError(
			"Usage: ryu-cli connect request <what the tool should do>"
		);
	}
	const input: { description: string; query?: string; toolkit?: string } = {
		description,
	};
	if (args.values.toolkit) {
		input.toolkit = args.values.toolkit;
	}
	if (args.values.query) {
		input.query = args.values.query;
	}
	const receipt = await connectClient(ctx, args).requestTool(input);
	if (ctx.flags.json) {
		printJson(ctx, receipt);
	} else {
		ctx.io.out(`${renderReceipt(receipt)}\n`);
	}
	return 0;
}

async function readArguments(
	ctx: CliContext,
	args: ConnectArgs
): Promise<Record<string, unknown>> {
	const { args: inline, argsFile } = args.values;
	if (inline !== undefined && argsFile !== undefined) {
		throw new UsageError("Give --args or --args-file, not both.");
	}
	let text = inline;
	if (argsFile === "-") {
		text = (await ctx.readStdin()) ?? undefined;
		if (text === undefined) {
			throw new UsageError("--args-file - needs the arguments on stdin.");
		}
	} else if (argsFile !== undefined) {
		text = await readFile(argsFile, "utf8");
	}
	if (text === undefined || text.trim() === "") {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new UsageError("Tool arguments must be JSON.");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new UsageError("Tool arguments must be a JSON object.");
	}
	return parsed as Record<string, unknown>;
}

/** The result's useful part: structured content, else its text items. */
function resultText(answer: CallAnswer): string {
	const { result } = answer;
	if (result.structuredContent !== undefined) {
		return JSON.stringify(result.structuredContent, null, 2);
	}
	const texts = (result.content ?? []).flatMap((item) =>
		item !== null &&
		typeof item === "object" &&
		"text" in item &&
		typeof item.text === "string"
			? [item.text]
			: []
	);
	return texts.join("\n");
}

async function call(ctx: CliContext, args: ConnectArgs): Promise<number> {
	const id = args.positional[1];
	if (!id) {
		throw new UsageError("Usage: ryu-cli connect call <id> [--args '<json>']");
	}
	const toolArgs = await readArguments(ctx, args);
	const idempotencyKey =
		args.values.idempotencyKey ?? `ryu-cli-${randomUUID()}`;
	if (idempotencyKey.length > 128) {
		throw new UsageError("--idempotency-key must be at most 128 characters.");
	}
	const options: { idempotencyKey: string; maxCostMicroUsd?: number } = {
		idempotencyKey,
	};
	const maxCost = integer(
		args.values.maxCost,
		"--max-cost",
		0,
		Number.MAX_SAFE_INTEGER
	);
	if (maxCost !== undefined) {
		options.maxCostMicroUsd = maxCost;
	}
	const answer = await connectClient(ctx, args).call(id, toolArgs, options);
	if (ctx.flags.json) {
		printJson(ctx, { ...answer, idempotencyKey });
		return answer.ok ? 0 : 1;
	}
	const text = resultText(answer);
	if (text) {
		ctx.io.out(text.endsWith("\n") ? text : `${text}\n`);
	}
	ctx.io.err(
		`${JSON.stringify({
			call_id: answer.ryuCallId,
			tool: id,
			ok: answer.ok,
			charged_micro_usd: answer.chargedMicroUsd,
			cost_micro_usd: answer.costMicroUsd,
			estimated: answer.estimated,
			price_source: answer.priceSource,
			exceeded_max_cost: answer.exceededMaxCost,
			idempotency_key: idempotencyKey,
		})}\n`
	);
	return answer.ok ? 0 : 1;
}

async function balance(ctx: CliContext, args: ConnectArgs): Promise<number> {
	const current = await connectClient(ctx, args).balance();
	if (ctx.flags.json) {
		printJson(ctx, current);
		return 0;
	}
	ctx.io.out(`${renderBalance(current)}\n`);
	return 0;
}

type Handler = (ctx: CliContext, args: ConnectArgs) => Promise<number>;

const SUBCOMMANDS = new Map<string, Handler>([
	["status", status],
	["browse", browse],
	["search", search],
	["describe", describe],
	["request", request],
	["call", call],
	["balance", balance],
]);

/** Global value flags (`dispatch.ts`) that `connect <agent>` accepts; skipped
 *  with their value when routing so `--agent <id>` is never read as a word. */
const ROUTING_VALUE_FLAGS = new Set([
	...VALUE_FLAGS.keys(),
	"--agent",
	"--file",
	"--node",
	"--template",
	"-f",
]);

/**
 * True when `ryu-cli connect …` addresses Ryu Connect (bare, `help`, or one of
 * {@link SUBCOMMANDS}) rather than a coding agent (`ryu-cli connect <agent>`,
 * `agentCommands.ts`). Both share the `connect` verb; the first positional
 * word decides, so neither form shadows the other.
 */
export function isConnectToolsInvocation(argv: readonly string[]): boolean {
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index] ?? "";
		if (token === "--") {
			const next = argv[index + 1];
			return next === undefined || next === "help" || SUBCOMMANDS.has(next);
		}
		if (token.startsWith("-")) {
			if (!token.includes("=") && ROUTING_VALUE_FLAGS.has(token)) {
				index++;
			}
			continue;
		}
		return token === "help" || SUBCOMMANDS.has(token);
	}
	return true;
}

export const connectCommand: Command = {
	name: "connect",
	summary:
		"Browse Ryu's tool catalog and search, describe, request and call Connect tools",
	usage: USAGE,
	run: async (ctx) => {
		const args = parseConnectArgs(ctx.rawArgs);
		const subcommand = args.positional[0] ?? "status";
		if (subcommand === "help") {
			ctx.io.out(`${renderConnectHelp()}\n`);
			return 0;
		}
		const handler = SUBCOMMANDS.get(subcommand);
		if (!handler) {
			throw new UsageError(
				`Unknown subcommand '${subcommand}'. Usage: ${USAGE} (see 'ryu-cli connect help').`
			);
		}
		try {
			return await handler(ctx, args);
		} catch (error) {
			if (error instanceof ConnectError) {
				return refusal(ctx, error);
			}
			throw error;
		}
	},
};
