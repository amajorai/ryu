/**
 * SDK MCP stdio server — exposes a set of SDK Runnables (and optional
 * passthrough registrations from Ghost / Shadow) as MCP tools over stdio,
 * so any MCP host can discover and call them.
 *
 * The server speaks the same JSON-RPC 2.0 / newline-delimited protocol as
 * `apps/core/src/sidecar/mcp/client.rs` and as `client.ts` in this package.
 *
 * POLICY NOTE: this server does NOT implement tool-approval, permission grants,
 * or any Gateway-level policy.  Approval stays in the chat layer; policy stays
 * in the Gateway (per issue #86).  Callers must not route policy decisions
 * through this server.
 *
 * ## Minimal Runnable contract
 *
 * The full `defineAgent / defineWorkflow / defineTool / defineSkill` authoring
 * API is delivered by issue #205.  This unit only needs the *consume side*:
 * an executable object with a name and a `run()` method.  Once #205 ships, its
 * builders will produce objects that satisfy this same interface.
 */

import { createInterface } from "node:readline";
import type { McpStdioCommand, McpTool } from "./client.ts";
import { callTool, listTools, MCP_PROTOCOL_VERSION } from "./client.ts";

// ── Minimal Runnable contract ─────────────────────────────────────────────────

/** JSON Schema fragment — enough to describe a tool's input arguments. */
export interface JsonSchema {
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	type?: string;
	[key: string]: unknown;
}

/**
 * The minimal executable Runnable interface consumed by this bridge.
 *
 * When #205 ships its `defineAgent / defineTool / ...` API, those builders must
 * return objects that satisfy this interface so they plug straight in here
 * without any adapter.
 */
export interface SdkRunnable {
	/** Human-readable description shown to MCP hosts. */
	description?: string;
	/** JSON Schema for the tool's input arguments. */
	inputSchema?: JsonSchema;
	/** Stable, unique tool name (no spaces; used as the MCP tool name). */
	name: string;
	/**
	 * Execute the runnable with the given arguments and return a result.
	 * The result is JSON-encoded into an MCP `text` content block.
	 */
	run(args: unknown): Promise<unknown>;
}

// ── Passthrough (Ghost / Shadow) ──────────────────────────────────────────────

/**
 * A passthrough registration forwards `tools/list` + `tools/call` to a remote
 * MCP server (e.g. Ghost at its stdio command, or Shadow at :3030).  The tools
 * are re-advertised under their original names; calls are forwarded verbatim.
 *
 * This is the mechanism by which orphaned Ghost (29 computer-use tools) and
 * Shadow (:3030 capture/search tools) can be advertised to any MCP host without
 * embedding their implementation in the SDK.
 */
export interface PassthroughRegistration {
	/** Command descriptor for the upstream MCP stdio server. */
	command: McpStdioCommand;
	/** Label used in error messages (e.g. "ghost", "shadow"). */
	label: string;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
	id?: number | string | null;
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	error?: { code: number; message: string };
	id: number | string | null;
	jsonrpc: "2.0";
	result?: unknown;
}

function respond(
	id: number | string | null | undefined,
	result: unknown
): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, result };
}

function respondError(
	id: number | string | null | undefined,
	code: number,
	message: string
): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Wrap a `run()` result in the MCP `tools/call` content-block envelope. */
function wrapContent(value: unknown): {
	content: { type: string; text: string }[];
} {
	return {
		content: [
			{
				type: "text",
				text: typeof value === "string" ? value : JSON.stringify(value),
			},
		],
	};
}

/**
 * Unwrap an MCP `tools/call` content-block envelope back to a plain value.
 * If the text is valid JSON it is parsed; otherwise the raw string is returned.
 *
 * This is exported so tests can verify that `decode(wrapContent(x))` round-trips
 * back to `x` and that `client.callTool()` output matches a direct `run()`.
 */
export function unwrapContent(raw: unknown): unknown {
	const r = raw as { content?: { type: string; text: string }[] } | null;
	const text = r?.content?.[0]?.text;
	if (text === undefined) {
		return raw;
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

// ── McpServer ─────────────────────────────────────────────────────────────────

/**
 * An MCP stdio server that exposes SDK Runnables and optional passthrough
 * registrations as MCP tools.
 *
 * @example
 * ```ts
 * import { McpServer } from "@ryuhq/sdk/mcp/server"
 *
 * const server = new McpServer()
 *   .register({ name: "greet", run: (a) => Promise.resolve(`Hello!`) })
 *
 * await server.serve()  // reads stdin, writes stdout until EOF
 * ```
 */
export class McpServer {
	private readonly runnables = new Map<string, SdkRunnable>();
	private readonly passthroughs: PassthroughRegistration[] = [];

	/**
	 * Register an SDK Runnable as an MCP tool.
	 * Returns `this` for chaining.
	 */
	register(runnable: SdkRunnable): this {
		this.runnables.set(runnable.name, runnable);
		return this;
	}

	/**
	 * Register a passthrough to an external MCP stdio server (e.g. Ghost or
	 * Shadow).  Tools from that server are fetched lazily and re-advertised.
	 * Returns `this` for chaining.
	 */
	passthrough(registration: PassthroughRegistration): this {
		this.passthroughs.push(registration);
		return this;
	}

	/** Fetch all tools: local Runnables + passthrough tools. */
	private async allTools(): Promise<McpTool[]> {
		const local: McpTool[] = [...this.runnables.values()].map((r) => ({
			name: r.name,
			description: r.description,
			inputSchema: r.inputSchema,
		}));

		const remote: McpTool[] = [];
		for (const pt of this.passthroughs) {
			try {
				const tools = await listTools(pt.command);
				remote.push(...tools);
			} catch (err) {
				// Degrade gracefully: log but don't crash the server.
				process.stderr.write(
					`[mcp-server] passthrough '${pt.label}' list_tools failed: ${err}\n`
				);
			}
		}

		return [...local, ...remote];
	}

	/** Handle a `tools/call` request. */
	private async handleCallTool(name: string, args: unknown): Promise<unknown> {
		const local = this.runnables.get(name);
		if (local) {
			const result = await local.run(args);
			return wrapContent(result);
		}

		// Not a local Runnable — try passthrough servers in order.
		for (const pt of this.passthroughs) {
			try {
				const tools = await listTools(pt.command);
				if (tools.some((t) => t.name === name)) {
					return await callTool(pt.command, name, args);
				}
			} catch {
				// continue to next passthrough
			}
		}

		throw new Error(`Unknown tool: ${name}`);
	}

	/**
	 * Handle a single parsed JSON-RPC request line. Returns the response to write
	 * (or null for notifications that require no response).
	 */
	private async handleRequest(
		req: JsonRpcRequest,
		initialized: { value: boolean },
		write: (obj: unknown) => void
	): Promise<void> {
		const { id, method, params } = req;

		if (method === "initialize") {
			initialized.value = true;
			write(
				respond(id, {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "ryu-sdk-server", version: "0.0.1" },
				})
			);
			return;
		}

		if (method === "notifications/initialized") {
			// Notification — no response required.
			return;
		}

		if (!initialized.value) {
			write(respondError(id, -32_002, "Server not initialized"));
			return;
		}

		if (method === "tools/list") {
			try {
				const tools = await this.allTools();
				write(respond(id, { tools }));
			} catch (err) {
				write(respondError(id, -32_603, String(err)));
			}
			return;
		}

		if (method === "tools/call") {
			await this.handleToolsCall(id, params, write);
			return;
		}

		write(respondError(id, -32_601, `Method not found: ${method}`));
	}

	/** Handle a `tools/call` JSON-RPC request. */
	private async handleToolsCall(
		id: number | string | null | undefined,
		params: unknown,
		write: (obj: unknown) => void
	): Promise<void> {
		const p = params as { name?: string; arguments?: unknown } | undefined;
		const toolName = p?.name;
		const toolArgs = p?.arguments ?? {};
		if (typeof toolName !== "string") {
			write(respondError(id, -32_602, "tools/call requires 'name'"));
			return;
		}
		try {
			const result = await this.handleCallTool(toolName, toolArgs);
			write(respond(id, result));
		} catch (err) {
			write(
				respond(id, {
					content: [{ type: "text", text: String(err) }],
					isError: true,
				})
			);
		}
	}

	/**
	 * Start reading JSON-RPC requests from the given readable stream and writing
	 * responses to the given writable stream.
	 *
	 * Defaults to `process.stdin` / `process.stdout`.  Passing explicit streams
	 * lets tests inject a pair of in-process pipes.
	 *
	 * Resolves when the input stream ends (EOF).
	 */
	serve(
		input: NodeJS.ReadableStream = process.stdin,
		output: NodeJS.WritableStream = process.stdout
	): Promise<void> {
		const write = (obj: unknown) => {
			output.write(`${JSON.stringify(obj)}\n`);
		};

		const initialized = { value: false };

		return new Promise<void>((resolve) => {
			const rl = createInterface({
				input,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			rl.on("line", (rawLine) => {
				const line = rawLine.trim();
				if (!line) {
					return;
				}

				let req: JsonRpcRequest;
				try {
					req = JSON.parse(line) as JsonRpcRequest;
				} catch {
					write(respondError(null, -32_700, "Parse error"));
					return;
				}

				this.handleRequest(req, initialized, write).catch((err) => {
					write(respondError(req.id, -32_603, String(err)));
				});
			});

			rl.on("close", resolve);
		});
	}
}
