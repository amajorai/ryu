// `ryu doctor agents`: probe Core's MCP endpoint and each coding agent's entry.

import { tf } from "../i18n/translate.ts";
import {
	BIN,
	connectionTarget,
	PROBE_PROTOCOL_VERSION,
	PROBE_TIMEOUT_MS,
} from "./agentCommands-shared.ts";
import {
	describeEntry,
	isRecordedEntry,
	type JsonValue,
	loadConnectState,
	MCP_SERVER_NAME,
	readConfigFile,
	readEntry,
	readEntryLenient,
	supportedAgents,
	TOKEN_ENV_VAR,
	type TokenMode,
	UnsupportedConfigError,
} from "./agentConnect.ts";
import { formatTable } from "./output.ts";
import type { CliContext } from "./types.ts";
import { VERSION } from "./version.ts";

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
			detail: tf("no node token (start Ryu once, or set {TOKEN_ENV_VAR})", {
				TOKEN_ENV_VAR,
			}),
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
			detail: tf("Core is not reachable ({error})", {
				error: error instanceof Error ? error.message : String(error),
			}),
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
		return tf(
			"{BIN} connect {agentId}  (rewrites the entry with the current node token)",
			{ BIN, agentId }
		);
	}
	if (probe.status === "forbidden") {
		return tf("{BIN} connect {agentId} --agent <ryu-agent-id>  ({detail})", {
			BIN,
			agentId,
			detail: probe.detail,
		});
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
