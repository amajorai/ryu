/**
 * Tool resolution + execution for the Ryu agent runtime.
 *
 * Two kinds of tool feed the same model `tools[]` array:
 *
 *  - **Local** tools are `ToolRunnable`s from `defineTool` — they run in-process
 *    via their `run(input, ctx)` implementation.
 *  - **Remote** tools are references to existing Ryu tools (e.g.
 *    `composio__GMAIL_SEARCH_EMAILS`) created with `ryuTool(id)`. Their schema is
 *    lazily fetched from Core `GET /api/tools/describe` and they execute through
 *    Core `POST /api/mcp/tools/call`, which enforces the agent's allowlist and
 *    selects the Composio connected-account entity via `user_id`.
 *
 * The model-facing function name is the **config key** the developer chose (e.g.
 * `gmailSearch`), not the raw Composio slug — internals stay hidden and names
 * stay OpenAI-safe.
 */

import type { RunnableContext } from "../runnable/runnable-types.ts";
import type { ToolRunnable } from "../runnable/tool.ts";
import type { ToolFunctionDef } from "./model-call.ts";

// ── Remote tool reference ─────────────────────────────────────────────────────

/** A reference to an existing Ryu tool, resolved + executed via Core. */
export interface RemoteToolRef {
	/** One-line description shown to the model (overrides Core's describe). */
	description?: string;
	/** Fully-qualified Ryu tool id, e.g. `composio__GMAIL_SEARCH_EMAILS`. */
	id: string;
	readonly kind: "remote";
	/**
	 * JSON Schema for the tool's arguments. Optional: when omitted, a permissive
	 * open-object schema is used (Composio `describe` is shallow), so supplying
	 * this materially improves the model's tool-call accuracy.
	 */
	parameters?: Record<string, unknown>;
}

/** Options accepted by `ryuTool`. */
export interface RyuToolOptions {
	description?: string;
	parameters?: Record<string, unknown>;
}

/**
 * Reference an existing Ryu tool by id so an `Agent` can call it.
 *
 * @example
 * ```ts
 * ryuTool("composio__GMAIL_SEARCH_EMAILS", {
 *   description: "Search the user's Gmail",
 *   parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
 * });
 * ```
 */
export function ryuTool(id: string, opts: RyuToolOptions = {}): RemoteToolRef {
	return {
		kind: "remote",
		id,
		description: opts.description,
		parameters: opts.parameters,
	};
}

/** A tool an `Agent` can expose to the model: local runnable or remote ref. */
export type AgentTool = RemoteToolRef | ToolRunnable;

/** Narrow to a local `defineTool` runnable. */
function isLocalTool(tool: AgentTool): tool is ToolRunnable {
	return tool.kind === "tool";
}

// ── Execution context ─────────────────────────────────────────────────────────

/** Everything the tool layer needs to resolve schemas + execute calls. */
export interface ToolExecContext {
	/** Core agent id — REQUIRED for remote tools (governs execution). */
	agentId?: string;
	/** Core base URL (no trailing `/api`). */
	coreBaseUrl: string;
	/** Bearer token for Core (`RYU_TOKEN`); may be undefined on loopback dev. */
	coreToken?: string;
	/** RunnableContext handed to local tools so they may call the gateway. */
	runnableContext: RunnableContext;
	/** Abort signal. */
	signal?: AbortSignal;
	/** Composio connected-account entity selector. */
	userId?: string;
}

const PERMISSIVE_OBJECT_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: true,
};

/** Core `/api/tools/describe` response subset we read. */
interface DescribeResponse {
	description?: string;
	name?: string;
}

function normalize(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function authHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (token) {
		headers.authorization = `Bearer ${token}`;
	}
	return headers;
}

/**
 * Build the OpenAI `tools[]` array the model sees, keyed by the developer's
 * config names. Remote tools without an explicit `parameters` schema are
 * described from Core (`describe` is shallow) and given a permissive schema.
 */
export async function resolveToolDefs(
	tools: Record<string, AgentTool>,
	ctx: ToolExecContext
): Promise<ToolFunctionDef[]> {
	const defs: ToolFunctionDef[] = [];

	for (const [name, tool] of Object.entries(tools)) {
		if (isLocalTool(tool)) {
			defs.push({
				type: "function",
				function: {
					name,
					description: tool.name,
					parameters: tool.schema as unknown as Record<string, unknown>,
				},
			});
			continue;
		}

		// Remote: prefer an explicit schema; else describe from Core.
		let description = tool.description;
		if (!description) {
			description = await describeRemoteTool(tool.id, ctx);
		}
		defs.push({
			type: "function",
			function: {
				name,
				description: description ?? tool.id,
				parameters: tool.parameters ?? PERMISSIVE_OBJECT_SCHEMA,
			},
		});
	}

	return defs;
}

async function describeRemoteTool(
	id: string,
	ctx: ToolExecContext
): Promise<string | undefined> {
	const url = `${normalize(ctx.coreBaseUrl)}/api/tools/describe?id=${encodeURIComponent(id)}`;
	try {
		const res = await fetch(url, {
			headers: authHeaders(ctx.coreToken),
			signal: ctx.signal,
		});
		if (!res.ok) {
			return undefined;
		}
		const json = (await res.json()) as DescribeResponse;
		return json.description || json.name || undefined;
	} catch {
		// Describe is best-effort — a missing description never blocks the loop.
		return undefined;
	}
}

// ── Execution ─────────────────────────────────────────────────────────────────

/** Result of executing one tool call. */
export interface ToolExecResult {
	/** Raw tool output (already JSON-parsed when the tool returned JSON). */
	output: unknown;
}

/**
 * Execute a single model tool call by config `name`, dispatching to the local
 * runnable or the Core `/api/mcp/tools/call` endpoint.
 *
 * `argsJson` is the raw JSON string from `tool_call.function.arguments`.
 */
export async function executeTool(
	name: string,
	argsJson: string,
	tools: Record<string, AgentTool>,
	ctx: ToolExecContext
): Promise<ToolExecResult> {
	const tool = tools[name];
	if (!tool) {
		throw new Error(`[ryu-sdk] model called unknown tool "${name}"`);
	}

	const args = parseArgs(argsJson, name);

	if (isLocalTool(tool)) {
		const output = await tool.run(
			args as Record<string, unknown>,
			ctx.runnableContext
		);
		return { output };
	}

	// Remote tool — requires a Core agent id for governance.
	if (!ctx.agentId) {
		throw new Error(
			`[ryu-sdk] remote tool "${name}" (${tool.id}) requires an agentId — ` +
				"set it on the Agent config so Core can govern the call"
		);
	}

	const url = `${normalize(ctx.coreBaseUrl)}/api/mcp/tools/call`;
	const res = await fetch(url, {
		method: "POST",
		headers: authHeaders(ctx.coreToken),
		signal: ctx.signal,
		body: JSON.stringify({
			tool: tool.id,
			arguments: args,
			agent_id: ctx.agentId,
			...(ctx.userId ? { user_id: ctx.userId } : {}),
		}),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`[ryu-sdk] Core tools/call ${res.status} for "${tool.id}"${text ? `: ${text}` : ""}`
		);
	}

	const json = (await res.json()) as {
		error?: string;
		ok?: boolean;
		output?: unknown;
	};
	if (json.ok === false) {
		throw new Error(
			`[ryu-sdk] tool "${tool.id}" failed: ${json.error ?? "unknown error"}`
		);
	}
	return { output: json.output };
}

function parseArgs(argsJson: string, name: string): unknown {
	const trimmed = (argsJson ?? "").trim();
	if (trimmed === "") {
		return {};
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		throw new Error(
			`[ryu-sdk] tool "${name}" arguments were not valid JSON: ${argsJson}`
		);
	}
}

// ── Elicitation (connection-required) detection ───────────────────────────────

/** The connect-required envelope Core returns when an account isn't linked. */
export interface Elicitation {
	kind?: string;
	message?: string;
	url?: string;
}

const ELICITATION_KEY = "__ryu_elicitation__";

/**
 * Detect Ryu's connection-required envelope in a tool output. Mirrors Core's
 * `detect_elicitation` (apps/core/src/sidecar/mcp/composio.rs): the first Gmail
 * call for an unconnected account returns `{ "__ryu_elicitation__": { url } }`.
 */
export function detectElicitation(output: unknown): Elicitation | null {
	if (typeof output !== "object" || output === null) {
		return null;
	}
	const envelope = (output as Record<string, unknown>)[ELICITATION_KEY];
	if (typeof envelope !== "object" || envelope === null) {
		return null;
	}
	return envelope as Elicitation;
}
