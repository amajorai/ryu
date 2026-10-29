// `ryu connect <agent>`, `ryu disconnect <agent>`, and `ryu doctor agents`: wire
// Ryu's MCP tools into an external coding agent (Claude Code, Codex, Cursor,
// opencode, Gemini CLI). The config formats and the merge/removal rules live in
// agentConnect.ts; this file is the command layer around them: resolving the Core
// URL and node token, the ownership guard, --dry-run/--print, and the doctor probe.

import { resolveLocalNodeToken } from "@ryuhq/core-client/node-token";
import { cliUserHome } from "../core/cliStatePath.ts";
import {
	type AgentTarget,
	type ConnectionRecord,
	DEFAULT_RYU_AGENT,
	deleteConfigFile,
	describeEntry,
	type EntrySpec,
	entryHash,
	fileMode,
	findAgent,
	isRecordedEntry,
	type JsonObject,
	type JsonValue,
	loadConnectState,
	MCP_SERVER_NAME,
	mcpEndpointUrl,
	readConfigFile,
	readEntry,
	readEntryLenient,
	redactToken,
	removeEntry,
	renderSnippet,
	sameEntry,
	saveConnectState,
	supportedAgents,
	TOKEN_ENV_VAR,
	type TokenMode,
	UnsupportedConfigError,
	writeEntry,
	writeFileAtomic,
} from "./agentConnect.ts";
import { formatTable } from "./output.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";
import { VERSION } from "./version.ts";

/** The installed binary name, used in every hint a user may copy. */
const BIN = "ryu-cli";
const PROBE_TIMEOUT_MS = 3000;
/** The pre-negotiation MCP revision Core accepts on a header-less initialize. */
const PROBE_PROTOCOL_VERSION = "2025-06-18";

function agentList(): string {
	return supportedAgents()
		.map((agent) => agent.id)
		.join(", ");
}

function requireAgent(ctx: CliContext, usage: string): AgentTarget {
	const id = ctx.args[0];
	if (!id) {
		throw new UsageError(`Usage: ${usage}\nAgents: ${agentList()}`);
	}
	const agent = findAgent(id);
	if (!agent) {
		throw new UsageError(
			`Unknown coding agent '${id}'. Supported: ${agentList()}.`
		);
	}
	return agent;
}

interface ConnectionTarget {
	coreUrl: string;
	home: string;
	mcpUrl: string;
	ryuAgent: string;
	token: string | null;
}

/** Core URL from `--node`/`RYU_CORE_URL` (the dispatcher's target), and the
 *  node token resolved like every other local surface: `RYU_CORE_TOKEN`, then
 *  `RYU_TOKEN`, then the token Core minted in its data dir (loopback URLs only). */
function connectionTarget(ctx: CliContext): ConnectionTarget {
	const coreUrl = ctx.target.url;
	const ryuAgent = ctx.flags.agent?.trim() || DEFAULT_RYU_AGENT;
	return {
		coreUrl,
		home: cliUserHome(ctx.env),
		mcpUrl: mcpEndpointUrl(coreUrl, ryuAgent),
		ryuAgent,
		token: ctx.target.token ?? resolveLocalNodeToken(coreUrl),
	};
}

function modeLabel(mode: number | null): string {
	return mode === null ? "new file, 0600" : `mode ${mode.toString(8)}`;
}

function writeJson(ctx: CliContext, value: unknown): void {
	ctx.io.out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Print the agent's snippet for manual pasting. Used by --print, and as the
 *  fallback when a config exists but cannot be edited safely. */
function printSnippet(
	ctx: CliContext,
	agent: AgentTarget,
	entry: JsonObject,
	configPath: string,
	tokenMode: TokenMode,
	reason: string | null,
	token: string | null
): number {
	// Only an explicit --print shows the token. The fallback (an uneditable
	// config, possibly under --dry-run or in a CI log) prints it redacted.
	const redacted = !ctx.flags.print && tokenMode === "inline";
	const full = renderSnippet(agent, entry);
	const snippet = redacted ? redactToken(full, token) : full;
	if (ctx.flags.json) {
		writeJson(ctx, {
			agent: agent.id,
			configPath,
			format: agent.format,
			printed: true,
			reason,
			snippet,
			tokenMode,
		});
	} else {
		if (reason) {
			ctx.io.err(
				`${reason}\nNothing was written. Add this to ${configPath}:\n`
			);
		} else {
			ctx.io.err(`Add this to ${configPath}:\n`);
		}
		ctx.io.out(snippet);
		if (redacted) {
			ctx.io.err(
				`The node token is redacted. Run ${BIN} connect ${agent.id} --print to include it, or use --token-env to reference $${TOKEN_ENV_VAR} instead.\n`
			);
		} else if (tokenMode === "inline") {
			ctx.io.err(
				`This snippet contains your Ryu node token. Use --token-env to reference $${TOKEN_ENV_VAR} instead.\n`
			);
		}
	}
	return reason ? 1 : 0;
}

type ConnectAction = "create" | "update" | "unchanged";

function decideConnect(
	ctx: CliContext,
	current: JsonValue | undefined,
	entry: JsonObject,
	record: ConnectionRecord | undefined,
	configPath: string
): ConnectAction {
	if (current === undefined) {
		return "create";
	}
	if (sameEntry(current, entry)) {
		return "unchanged";
	}
	if (isRecordedEntry(current, record, configPath) || ctx.flags.force) {
		return "update";
	}
	const url = describeEntry(current).url ?? "unknown URL";
	throw new Error(
		`${configPath} already has an MCP server named '${MCP_SERVER_NAME}' that ${BIN} did not add (it points at ${url}). Re-run with --force to replace it, or with --print to see Ryu's entry.`
	);
}

const connectUsage = `${BIN} connect <agent> [--agent <ryu-agent>] [--token-env] [--force] [--dry-run] [--print]`;

export const connectCommand: Command = {
	name: "connect",
	summary: "Add Ryu's MCP tools to a coding agent (claude-code, codex, …)",
	usage: "ryu connect <agent> [--token-env] [--print]",
	run: async (ctx) => {
		const agent = requireAgent(ctx, connectUsage);
		const target = connectionTarget(ctx);
		const tokenMode: TokenMode = ctx.flags.tokenEnv ? "env" : "inline";
		if (tokenMode === "inline" && !target.token) {
			throw new Error(
				`No node token is available for ${target.coreUrl}. Start Ryu once so it creates its node token, set ${TOKEN_ENV_VAR}, or use --token-env.`
			);
		}
		const spec: EntrySpec = {
			mcpUrl: target.mcpUrl,
			token: target.token,
			tokenMode,
		};
		const entry = agent.buildEntry(spec);
		const configPath = agent.configPath(ctx.env, target.home);
		if (ctx.flags.print) {
			return printSnippet(
				ctx,
				agent,
				entry,
				configPath,
				tokenMode,
				null,
				target.token
			);
		}

		let text: string | null;
		let current: JsonValue | undefined;
		let next: string;
		const state = loadConnectState(ctx.env);
		const record = state.agents[agent.id];
		let action: ConnectAction;
		try {
			text = readConfigFile(configPath);
			current = readEntry(agent, text, configPath);
			action = decideConnect(ctx, current, entry, record, configPath);
			next =
				action === "unchanged"
					? (text ?? "")
					: writeEntry(agent, text, entry, configPath);
		} catch (error) {
			if (error instanceof UnsupportedConfigError) {
				return printSnippet(
					ctx,
					agent,
					entry,
					configPath,
					tokenMode,
					error.message,
					target.token
				);
			}
			throw error;
		}

		const summary = {
			action,
			agent: agent.id,
			configPath,
			dryRun: ctx.flags.dryRun,
			mcpUrl: target.mcpUrl,
			tokenMode,
		};
		if (ctx.flags.dryRun) {
			if (ctx.flags.json) {
				writeJson(ctx, {
					...summary,
					snippet: redactToken(renderSnippet(agent, entry), target.token),
				});
				return 0;
			}
			const verb =
				action === "create"
					? "add"
					: action === "update"
						? "replace"
						: "leave unchanged";
			ctx.io.out(
				`Dry run — would ${verb} the '${MCP_SERVER_NAME}' MCP server in ${configPath}:\n${redactToken(renderSnippet(agent, entry), target.token)}`
			);
			return 0;
		}

		const priorMode = fileMode(configPath);
		if (action !== "unchanged") {
			writeFileAtomic(configPath, next);
		}
		const createdFile =
			text === null ||
			(record?.configPath === configPath && record.createdFile);
		state.agents[agent.id] = {
			configPath,
			createdFile,
			entryHash: entryHash(entry),
			mcpUrl: target.mcpUrl,
			tokenMode,
		};
		saveConnectState(ctx.env, state);

		if (ctx.flags.json) {
			writeJson(ctx, summary);
			return 0;
		}
		const done =
			action === "unchanged"
				? `${agent.label} is already connected to Ryu`
				: `Connected ${agent.label} to Ryu`;
		ctx.io.out(
			`${done}: MCP server '${MCP_SERVER_NAME}' → ${target.mcpUrl}\nConfig: ${configPath}\n${agent.reloadHint}\n`
		);
		if (tokenMode === "inline") {
			const groupReadable = priorMode !== null && (priorMode & 0o077) !== 0;
			ctx.io.err(
				`Note: the Ryu node token is stored in plain text in ${configPath} (${modeLabel(priorMode)}).${groupReadable ? " That file is readable by other users; consider chmod 600." : ""} Use --token-env to reference $${TOKEN_ENV_VAR} instead.\n`
			);
		} else {
			ctx.io.err(
				`Note: ${agent.label} must be started with ${TOKEN_ENV_VAR} set to the node token.\n`
			);
		}
		return 0;
	},
};

/** True when `current` is an entry Ryu wrote: the recorded one, or one equal to
 *  what `connect` would write now (for example pasted from `--print`). */
function isRyuOwned(
	agent: AgentTarget,
	current: JsonValue,
	record: ConnectionRecord | undefined,
	configPath: string,
	target: ConnectionTarget
): boolean {
	if (isRecordedEntry(current, record, configPath)) {
		return true;
	}
	const candidates: EntrySpec[] = [
		{ mcpUrl: target.mcpUrl, token: null, tokenMode: "env" },
	];
	if (target.token) {
		candidates.push({
			mcpUrl: target.mcpUrl,
			token: target.token,
			tokenMode: "inline",
		});
	}
	return candidates.some((spec) => sameEntry(current, agent.buildEntry(spec)));
}

export const disconnectCommand: Command = {
	name: "disconnect",
	summary: "Remove the Ryu MCP entry that 'connect' added to a coding agent",
	usage: "ryu disconnect <agent> [--force] [--dry-run]",
	run: async (ctx) => {
		const agent = requireAgent(
			ctx,
			`${BIN} disconnect <agent> [--force] [--dry-run]`
		);
		const target = connectionTarget(ctx);
		const configPath = agent.configPath(ctx.env, target.home);
		const state = loadConnectState(ctx.env);
		const record = state.agents[agent.id];
		const { [agent.id]: _dropped, ...remainingRecords } = state.agents;

		let text: string | null;
		let current: JsonValue | undefined;
		try {
			text = readConfigFile(configPath);
			current = readEntry(agent, text, configPath);
		} catch (error) {
			if (error instanceof UnsupportedConfigError) {
				throw new Error(
					`${error.message} Remove the '${MCP_SERVER_NAME}' MCP server from ${configPath} by hand.`
				);
			}
			throw error;
		}

		if (text === null || current === undefined) {
			if (!ctx.flags.dryRun && record) {
				saveConnectState(ctx.env, { ...state, agents: remainingRecords });
			}
			if (ctx.flags.json) {
				writeJson(ctx, { action: "absent", agent: agent.id, configPath });
			} else {
				ctx.io.out(`${agent.label} has no Ryu MCP entry in ${configPath}.\n`);
			}
			return 0;
		}

		if (
			!(
				ctx.flags.force ||
				isRyuOwned(agent, current, record, configPath, target)
			)
		) {
			throw new Error(
				`The '${MCP_SERVER_NAME}' MCP server in ${configPath} was changed after ${BIN} connect wrote it, or was added by something else. Re-run with --force to remove it anyway.`
			);
		}

		let next: string | null;
		try {
			// The created-file marker only applies to the file it was recorded for
			// (CLAUDE_CONFIG_DIR / CODEX_HOME / opencode.json(c) can change).
			const createdFile =
				record?.configPath === configPath && record.createdFile;
			next = removeEntry(agent, text, createdFile, configPath);
		} catch (error) {
			if (error instanceof UnsupportedConfigError) {
				throw new Error(
					`${error.message} Remove the '${MCP_SERVER_NAME}' MCP server from ${configPath} by hand.`
				);
			}
			throw error;
		}

		const summary = {
			action: next === null ? "delete-file" : "remove",
			agent: agent.id,
			configPath,
			dryRun: ctx.flags.dryRun,
		};
		if (ctx.flags.dryRun) {
			if (ctx.flags.json) {
				writeJson(ctx, summary);
			} else {
				ctx.io.out(
					next === null
						? `Dry run — would delete ${configPath} (${BIN} created it and it holds nothing else).\n`
						: `Dry run — would remove the '${MCP_SERVER_NAME}' MCP server from ${configPath}.\n`
				);
			}
			return 0;
		}

		if (next === null) {
			deleteConfigFile(configPath);
		} else {
			writeFileAtomic(configPath, next);
		}
		saveConnectState(ctx.env, { ...state, agents: remainingRecords });
		if (ctx.flags.json) {
			writeJson(ctx, summary);
		} else {
			ctx.io.out(
				`Disconnected ${agent.label}: removed the '${MCP_SERVER_NAME}' MCP server from ${configPath}.\n`
			);
		}
		return 0;
	},
};

// ── ryu doctor agents ───────────────────────────────────────────────────────────

export type ProbeStatus =
	| "ok"
	| "no-token"
	| "unauthorized"
	| "forbidden"
	| "unreachable"
	| "error";

export interface ProbeResult {
	detail: string;
	status: ProbeStatus;
	url: string;
}

function errorMessageFrom(body: unknown): string | null {
	if (typeof body !== "object" || body === null) {
		return null;
	}
	const error = Reflect.get(body, "error");
	if (typeof error === "string") {
		return error;
	}
	if (typeof error === "object" && error !== null) {
		const message = Reflect.get(error, "message");
		return typeof message === "string" ? message : null;
	}
	return null;
}

/** One MCP `initialize` against Core's `/mcp/<agent>` route: cheap, side-effect
 *  free, and exercises exactly the auth + agent admission an MCP host hits. */
export async function probeMcpEndpoint(
	ctx: CliContext,
	url: string,
	token: string | null
): Promise<ProbeResult> {
	if (!token) {
		return {
			detail: `no node token (start Ryu once, or set ${TOKEN_ENV_VAR})`,
			status: "no-token",
			url,
		};
	}
	let response: Response;
	try {
		response = await ctx.fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: PROBE_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "ryu-cli-doctor", version: VERSION },
				},
			}),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		return {
			detail: `Core is not reachable (${error instanceof Error ? error.message : String(error)})`,
			status: "unreachable",
			url,
		};
	}
	const body: unknown = await response.json().catch(() => null);
	const message = errorMessageFrom(body);
	if (response.status === 401) {
		return {
			detail: message ?? "the node token was rejected",
			status: "unauthorized",
			url,
		};
	}
	if (response.status === 403) {
		return {
			detail: message ?? "forbidden",
			status: "forbidden",
			url,
		};
	}
	if (!response.ok || message) {
		return {
			detail: message ?? `HTTP ${response.status}`,
			status: "error",
			url,
		};
	}
	const result =
		typeof body === "object" && body !== null
			? Reflect.get(body, "result")
			: null;
	const version =
		typeof result === "object" && result !== null
			? Reflect.get(result, "protocolVersion")
			: null;
	return {
		detail: typeof version === "string" ? `MCP ${version}` : "initialized",
		status: "ok",
		url,
	};
}

export type AgentStatus =
	| "connected"
	| "unverified"
	| "not-connected"
	| "other-node"
	| "broken"
	| "unreadable";

export interface AgentReport {
	binary: string | null;
	configPath: string;
	/** Endpoint check made with the credential this agent's entry uses. */
	endpoint: ProbeResult | null;
	fix: string | null;
	id: string;
	label: string;
	/** Whether the entry is the one `ryu connect` recorded writing. */
	managedByRyu: boolean;
	notes: string[];
	status: AgentStatus;
	tokenMode: TokenMode | "none" | null;
	url: string | null;
}

export interface AgentsDoctorReport {
	agents: AgentReport[];
	coreUrl: string;
	endpoint: ProbeResult;
}

function findBinary(ctx: CliContext, names: string[]): string | null {
	const path = ctx.env.PATH ?? ctx.env.Path ?? "";
	for (const name of names) {
		const found = Bun.which(name, { PATH: path });
		if (found) {
			return found;
		}
	}
	return null;
}

function probeFixHint(probe: ProbeResult, agentId: string): string {
	if (probe.status === "unauthorized") {
		return `${BIN} connect ${agentId}  (rewrites the entry with the current node token)`;
	}
	if (probe.status === "forbidden") {
		return `${BIN} connect ${agentId} --agent <ryu-agent-id>  (${probe.detail})`;
	}
	return "Start Ryu (the desktop app, or run ryu-cli once)";
}

export async function buildAgentsDoctorReport(
	ctx: CliContext
): Promise<AgentsDoctorReport> {
	const target = connectionTarget(ctx);
	const state = loadConnectState(ctx.env);
	const probes = new Map<string, Promise<ProbeResult>>();
	const probe = (url: string, token: string | null) => {
		const key = `${url}\n${token ?? ""}`;
		let pending = probes.get(key);
		if (!pending) {
			pending = probeMcpEndpoint(ctx, url, token);
			probes.set(key, pending);
		}
		return pending;
	};
	const endpoint = await probe(target.mcpUrl, target.token);
	const mcpBase = `${target.coreUrl.replace(/\/+$/, "")}/mcp/`;

	const agents: AgentReport[] = [];
	for (const agent of supportedAgents()) {
		const configPath = agent.configPath(ctx.env, target.home);
		const report: AgentReport = {
			binary: findBinary(ctx, agent.binaries),
			configPath,
			endpoint: null,
			fix: null,
			id: agent.id,
			label: agent.label,
			managedByRyu: false,
			notes: [],
			status: "not-connected",
			tokenMode: null,
			url: null,
		};
		agents.push(report);

		let current: JsonValue | undefined;
		try {
			const text = readConfigFile(configPath);
			try {
				current = readEntry(agent, text, configPath);
			} catch (error) {
				// A commented JSONC file (opencode.jsonc, Gemini settings) is valid
				// for its agent; read it leniently rather than reporting it broken.
				if (!(error instanceof UnsupportedConfigError)) {
					throw error;
				}
				current = readEntryLenient(agent, text, configPath);
				if (current !== undefined) {
					report.notes.push(
						`${configPath} has comments, so ${BIN} connect/disconnect cannot edit it; change the '${MCP_SERVER_NAME}' entry by hand.`
					);
				}
			}
		} catch (error) {
			report.status = "unreadable";
			report.notes.push(error instanceof Error ? error.message : String(error));
			report.fix = `Fix ${configPath}, or run ${BIN} connect ${agent.id} --print and add the entry by hand`;
			continue;
		}
		if (current === undefined) {
			if (report.binary) {
				report.fix = `${BIN} connect ${agent.id}`;
			}
			continue;
		}

		const info = describeEntry(current);
		report.url = info.url;
		report.tokenMode = info.tokenMode;
		report.managedByRyu = isRecordedEntry(
			current,
			state.agents[agent.id],
			configPath
		);
		if (!info.url?.startsWith(mcpBase)) {
			report.status = "other-node";
			report.notes.push(
				`The '${MCP_SERVER_NAME}' entry points at ${info.url ?? "no URL"}, not at ${mcpBase}…`
			);
			report.fix = `${BIN} connect ${agent.id}${report.managedByRyu ? "" : " --force"}`;
			continue;
		}

		let credential: string | null = target.token;
		if (info.tokenMode === "inline") {
			credential = info.inlineToken;
		} else if (info.tokenMode === "env") {
			const fromEnv = ctx.env[TOKEN_ENV_VAR]?.trim();
			if (fromEnv) {
				credential = fromEnv;
			} else {
				report.notes.push(
					`The entry reads the token from $${TOKEN_ENV_VAR}, which is not set in this shell; ${agent.label} needs it in its environment.`
				);
			}
		} else {
			// Core's /mcp route always requires a bearer, so this entry cannot
			// work; probing with our own token would report a false "connected".
			report.status = "broken";
			report.notes.push("The entry sends no Authorization header.");
			report.fix = `${BIN} connect ${agent.id}${report.managedByRyu ? "" : " --force"}`;
			continue;
		}
		report.endpoint = await probe(info.url, credential);
		if (report.endpoint.status === "ok") {
			report.status = "connected";
		} else if (report.endpoint.status === "unreachable") {
			// The entry is in place; only Core is down, which the endpoint line
			// already reports and fixes.
			report.status = "unverified";
		} else {
			report.status = "broken";
			report.fix = probeFixHint(report.endpoint, agent.id);
		}
	}
	return { agents, coreUrl: target.coreUrl, endpoint };
}

const STATUS_LABELS: Record<AgentStatus, string> = {
	broken: "broken",
	connected: "connected",
	"not-connected": "not connected",
	"other-node": "other node",
	unreadable: "unreadable",
	unverified: "configured (Core down)",
};

export function renderAgentsDoctorReport(report: AgentsDoctorReport): string {
	const lines = [
		`Ryu MCP endpoint ${report.endpoint.url}: ${report.endpoint.status === "ok" ? "ok" : report.endpoint.status} (${report.endpoint.detail})`,
		"",
		formatTable(
			["AGENT", "ON PATH", "RYU ENTRY", "CONFIG"],
			report.agents.map((agent) => [
				agent.id,
				agent.binary ?? "no",
				STATUS_LABELS[agent.status],
				agent.configPath,
			])
		),
	];
	const notes = report.agents.flatMap((agent) => [
		...agent.notes.map((note) => `  ${agent.id}: ${note}`),
		...(agent.endpoint &&
		agent.endpoint.status !== "ok" &&
		agent.endpoint.status !== "unreachable"
			? [`  ${agent.id}: ${agent.endpoint.status} — ${agent.endpoint.detail}`]
			: []),
		...(agent.tokenMode === "inline"
			? [`  ${agent.id}: the node token is stored inline in its config`]
			: []),
	]);
	if (notes.length > 0) {
		lines.push("", "Notes:", ...notes);
	}
	const fixes = report.agents
		.filter((agent) => agent.fix)
		.map((agent) => `  ${agent.id}: ${agent.fix}`);
	if (report.endpoint.status !== "ok") {
		fixes.unshift(`  endpoint: ${probeFixHint(report.endpoint, "<agent>")}`);
	}
	if (fixes.length > 0) {
		lines.push("", "Fixes:", ...fixes);
	}
	return `${lines.join("\n")}\n`;
}

/** `ryu doctor agents`: exit 1 when the endpoint fails or a configured agent's
 *  entry is broken or unreadable; an agent that is simply not connected is fine. */
export async function runAgentsDoctor(ctx: CliContext): Promise<number> {
	const report = await buildAgentsDoctorReport(ctx);
	ctx.io.out(
		ctx.flags.json
			? `${JSON.stringify(report, null, 2)}\n`
			: renderAgentsDoctorReport(report)
	);
	const failing =
		report.endpoint.status !== "ok" ||
		report.agents.some(
			(agent) => agent.status === "broken" || agent.status === "unreadable"
		);
	return failing ? 1 : 0;
}
