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
	type CallAnswer,
	CatalogClient,
	ConnectClient,
	ConnectError,
	type DescribedTool,
	formatMicroUsd,
	type PlatformDetail,
	type PlatformIndex,
} from "./connectClient.ts";
import { formatTable, truncate } from "./output.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";
import { VERSION } from "./version.ts";

const USAGE =
	"ryu-cli connect [status|browse [platform]|search <words>|describe <id>|request <text>|call <id>|balance]";

const HELP = `ryu-cli connect: Ryu Connect from the terminal

Usage:
  ryu-cli connect                      Live status: Connect URL, health, key, balance
  ryu-cli connect browse [platform]    Ryu's tool catalog: platforms, or one platform's endpoints with USD prices
  ryu-cli connect search <words…>      Search the tools your key can call (--limit 1-25, --kind any|composio|mcp)
  ryu-cli connect describe <id>        One tool's price, verification, reliability and argument schema
  ryu-cli connect request <text…>      Ask for a missing tool (--toolkit, --query)
  ryu-cli connect call <id>            Call a tool (--args '<json>', --args-file <path|->, --max-cost <micro-USD>,
                                       --idempotency-key <label>); prints the result, then one JSON line with
                                       the call id and charge on stderr
  ryu-cli connect balance              What new calls can spend right now
  ryu-cli connect <agent>              Add Ryu's MCP tools to a coding agent (claude-code, codex, …)

Environment:
  RYU_CONNECT_URL       Connect base URL (or --url <url>)
  RYU_CONNECT_KEY       Connect key, sent only to RYU_CONNECT_URL
  RYU_TOOL_CATALOG_URL  Catalog base URL for 'browse' (or --catalog-url <url>)

Add --json for machine-readable output.`;

type ValueName =
	| "args"
	| "argsFile"
	| "catalogUrl"
	| "idempotencyKey"
	| "kind"
	| "limit"
	| "maxCost"
	| "query"
	| "toolkit"
	| "url";

const VALUE_FLAGS = new Map<string, ValueName>([
	["--args", "args"],
	["--args-file", "argsFile"],
	["--catalog-url", "catalogUrl"],
	["--idempotency-key", "idempotencyKey"],
	["--kind", "kind"],
	["--limit", "limit"],
	["--max-cost", "maxCost"],
	["--query", "query"],
	["--toolkit", "toolkit"],
	["--url", "url"],
]);

export interface ConnectArgs {
	positional: string[];
	values: Partial<Record<ValueName, string>>;
}

/** Parse `ryu-cli connect`'s own argv (everything after `connect`). */
export function parseConnectArgs(argv: readonly string[]): ConnectArgs {
	const positional: string[] = [];
	const values: Partial<Record<ValueName, string>> = {};
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index] ?? "";
		if (token === "--") {
			positional.push(...argv.slice(index + 1));
			break;
		}
		if (token === "--json") {
			continue;
		}
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			const name = eq === -1 ? token : token.slice(0, eq);
			const key = VALUE_FLAGS.get(name);
			if (!key) {
				throw new UsageError(
					`Unknown option '${name}' (see 'ryu-cli connect help').`
				);
			}
			const value = eq === -1 ? argv[index + 1] : token.slice(eq + 1);
			if (value === undefined || (eq === -1 && value.startsWith("--"))) {
				throw new UsageError(`${name} needs a value.`);
			}
			if (eq === -1) {
				index++;
			}
			values[key] = value;
			continue;
		}
		positional.push(token);
	}
	return { positional, values };
}

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
			"The Ryu tool catalog is turned off (RYU_TOOL_CATALOG_URL=off)."
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

function integer(
	value: string | undefined,
	name: string,
	min: number,
	max: number
): number | undefined {
	if (value === undefined) {
		return;
	}
	if (
		!/^\d{1,15}$/u.test(value) ||
		Number(value) < min ||
		Number(value) > max
	) {
		throw new UsageError(
			`${name} must be a whole number from ${min} to ${max}.`
		);
	}
	return Number(value);
}

interface CostLike {
	basis: string;
	free: boolean;
	usd: number | null;
}

/** One call's price from the catalog: `free`, `$0.005`, `$0.005+` (more meters), `usage`, `unverified`. */
export function formatCatalogCost(cost: CostLike | null): string {
	if (!cost) {
		return "-";
	}
	if (cost.free) {
		return "free";
	}
	if (cost.basis === "usage") {
		return "usage";
	}
	if (cost.usd === null) {
		return "unverified";
	}
	const text = formatMicroUsd(Math.round(cost.usd * 1_000_000));
	return cost.basis === "base_call" ? `${text}+` : text;
}

function priceText(price: DescribedTool["price"]): string {
	if (price.source === "unmetered") {
		return "unmetered";
	}
	const amount = formatMicroUsd(price.amountMicroUsd);
	return price.estimated ? `~${amount}` : amount;
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
	const rows: string[][] = [
		[
			"Connect",
			`${client.origin}  ${health.service} ${health.version ?? ""}`.trim(),
		],
		[
			"Key",
			client.hasKey
				? "set (RYU_CONNECT_KEY)"
				: "not set: export RYU_CONNECT_KEY",
		],
	];
	if (balance) {
		rows.push([
			"Balance",
			balance.billed
				? `${formatMicroUsd(balance.availableMicroUsd)} available, ${formatMicroUsd(balance.heldMicroUsd)} held${balance.suspended ? " (suspended)" : ""}`
				: "not billed by Ryu",
		]);
	}
	rows.push(["Catalog", catalog ?? "off"]);
	ctx.io.out(
		`${rows.map(([name, value]) => `${(name ?? "").padEnd(9)}${value}`).join("\n")}\n`
	);
	return 0;
}

function renderIndex(ctx: CliContext, index: PlatformIndex): void {
	if (index.platforms.length === 0) {
		ctx.io.out("The catalog lists no platforms yet.\n");
		return;
	}
	const rows = index.platforms.map((platform) => [
		platform.slug,
		String(platform.endpoints),
		String(platform.verified_endpoints),
		formatCatalogCost(platform.price_from),
		truncate(platform.providers.join(", "), 40),
	]);
	ctx.io.out(
		`${formatTable(["PLATFORM", "ENDPOINTS", "VERIFIED", "FROM", "PROVIDERS"], rows)}\n`
	);
}

function renderPlatform(ctx: CliContext, detail: PlatformDetail): void {
	ctx.io.out(`${detail.label} (${detail.slug})\n`);
	const rows: string[][] = [];
	for (const domain of detail.domains) {
		for (const row of domain.rows) {
			for (const endpoint of row.endpoints) {
				rows.push([
					truncate(row.capability_name, 32),
					endpoint.id,
					endpoint.provider_display,
					formatCatalogCost(endpoint.cost),
					endpoint.verification.state,
					endpoint.id === row.cheapest_endpoint ? "cheapest" : "",
				]);
			}
		}
	}
	ctx.io.out(
		`${formatTable(["CAPABILITY", "ENDPOINT", "PROVIDER", "PER CALL", "STATE", ""], rows)}\n`
	);
}

async function browse(ctx: CliContext, args: ConnectArgs): Promise<number> {
	const client = catalogClient(ctx, args);
	const slug = args.positional[1];
	if (slug) {
		const detail = await client.platform(slug);
		if (ctx.flags.json) {
			printJson(ctx, detail);
		} else {
			renderPlatform(ctx, detail);
		}
		return 0;
	}
	const index = await client.platforms();
	if (ctx.flags.json) {
		printJson(ctx, index);
	} else {
		renderIndex(ctx, index);
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
	if (result.data.length === 0) {
		const lines = ["No tools matched."];
		if (result.missedTerms?.length) {
			lines.push(`No tool matched: ${result.missedTerms.join(", ")}`);
		}
		if (result.didYouMean?.length) {
			lines.push(`Did you mean: ${result.didYouMean.join(", ")}`);
		}
		lines.push(
			"File it with: ryu-cli connect request <what the tool should do>"
		);
		ctx.io.out(`${lines.join("\n")}\n`);
		return 0;
	}
	const rows = result.data.map((tool) => [
		tool.id,
		tool.provider,
		tool.tier,
		priceText(tool.price),
		tool.catalog?.state ?? "",
		tool.score === undefined ? "" : tool.score.toFixed(2),
	]);
	ctx.io.out(
		`${formatTable(["ID", "PROVIDER", "TIER", "PRICE", "CATALOG", "SCORE"], rows)}\n`
	);
	if (result.partial) {
		ctx.io.out(
			"Some tool sources did not answer; the list may be incomplete.\n"
		);
	}
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
	const reliability = tool.reliability;
	const lines = [
		`${tool.name} (${tool.id})`,
		`Provider   ${tool.provider} · ${tool.tier}${tool.toolkit ? ` · ${tool.toolkit}` : ""}`,
		`Price      ${priceText(tool.price)} per call (${tool.price.source})`,
	];
	if (tool.catalog?.state) {
		lines.push(
			`Catalog    ${tool.catalog.state} (${tool.catalog.source ?? "ryu"})`
		);
	}
	if (reliability?.sufficient && typeof reliability.successRate === "number") {
		lines.push(
			`Reliable   ${(reliability.successRate * 100).toFixed(1)}% over 7 days, p50 ${reliability.p50Ms ?? "-"} ms, p95 ${reliability.p95Ms ?? "-"} ms`
		);
	}
	lines.push("", tool.description, "", "Parameters:");
	lines.push(JSON.stringify(tool.parameters ?? {}, null, 2));
	ctx.io.out(`${lines.join("\n")}\n`);
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
		ctx.io.out(
			`Request ${receipt.status}${receipt.id ? ` (${receipt.id})` : ""}.\n`
		);
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
	if (!current.billed) {
		ctx.io.out(
			"This Connect is not billed by Ryu; calls are never refused for credit.\n"
		);
		return 0;
	}
	const lines = [
		`Available  ${formatMicroUsd(current.availableMicroUsd)}`,
		`Held       ${formatMicroUsd(current.heldMicroUsd)}`,
		`Unsettled  ${formatMicroUsd(current.unsettledMicroUsd)}`,
	];
	if (current.suspended) {
		lines.push("Suspended  yes: add credit to resume calls");
	}
	if (current.topUpUrl) {
		lines.push(`Top up     ${current.topUpUrl}`);
	}
	ctx.io.out(`${lines.join("\n")}\n`);
	return 0;
}

/** Render a refusal with what to do next; exit 1. */
function refusal(ctx: CliContext, error: ConnectError): number {
	if (ctx.flags.json) {
		ctx.io.err(
			`${JSON.stringify({
				...error.body,
				error: error.message,
				code: error.code,
				status: error.status,
			})}\n`
		);
		return 1;
	}
	const lines = [`Error: ${error.message}`];
	const body = error.body;
	if (Array.isArray(body.didYouMean) && body.didYouMean.length > 0) {
		lines.push(`Did you mean: ${body.didYouMean.join(", ")}`);
	}
	if (typeof body.top_up_url === "string") {
		lines.push(`Add credit: ${body.top_up_url}`);
	}
	if (
		body.precondition !== null &&
		typeof body.precondition === "object" &&
		"toolkit" in body.precondition
	) {
		lines.push(
			`Connect the ${String(body.precondition.toolkit)} account (in Ryu, from Integrations), then run the same call again.`
		);
	}
	if (error.retryAfterSeconds !== null) {
		lines.push(`Retry after ${error.retryAfterSeconds} s.`);
	}
	ctx.io.err(`${lines.join("\n")}\n`);
	return 1;
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
			ctx.io.out(`${HELP}\n`);
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
