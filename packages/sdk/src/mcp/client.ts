/**
 * SDK MCP stdio client — a TypeScript mirror of the wire contract in
 * `apps/core/src/sidecar/mcp/client.rs`.
 *
 * This implements the same JSON-RPC 2.0 / newline-delimited transport:
 *   1. Spawn the MCP server process.
 *   2. Send `initialize` (protocolVersion "2024-11-05") and receive the result.
 *   3. Send `notifications/initialized`.
 *   4. Call `tools/list` or `tools/call` as needed.
 *   5. Tear down the process.
 *
 * POLICY NOTE: this client does NOT implement tool-approval or request-level
 * policy enforcement.  Approval and policy live in the chat layer and the
 * Gateway (per issue #86).  Any policy that must run before a tool call must be
 * wired upstream by the caller, not here.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** MCP protocol version sent during `initialize`. Matches client.rs. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Timeout (ms) waiting for a single JSON-RPC response. */
const RPC_TIMEOUT_MS = 60_000;

/** A tool entry from `tools/list`. */
export interface McpTool {
	description?: string;
	/** JSON Schema object for the tool's input arguments. */
	inputSchema?: unknown;
	name: string;
}

/** Command descriptor for spawning an MCP stdio server. */
export interface McpStdioCommand {
	args?: string[];
	command: string;
	env?: Record<string, string>;
}

/** A line-delimited JSON value read from the server's stdout. */
interface JsonRpcFrame {
	error?: { code: number; message: string; data?: unknown };
	id?: number | null;
	jsonrpc: "2.0";
	method?: string;
	params?: unknown;
	result?: unknown;
}

/**
 * Pending response waiter: each in-flight request registers a handler that
 * receives the next line whose `id` matches.
 */
interface ResponseWaiter {
	id: number;
	reject: (err: unknown) => void;
	resolve: (result: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** A live connection to a spawned MCP stdio server. */
class McpConnection {
	private readonly proc: ReturnType<typeof spawn>;
	private nextId = 1;
	private closed = false;
	private readonly waiters: ResponseWaiter[] = [];

	private constructor(proc: ReturnType<typeof spawn>) {
		this.proc = proc;
	}

	/** Spawn the server and complete the MCP `initialize` handshake. */
	static async connect(cmd: McpStdioCommand): Promise<McpConnection> {
		const env = { ...process.env, ...(cmd.env ?? {}) };
		const proc = spawn(cmd.command, cmd.args ?? [], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});

		if (!(proc.stdin && proc.stdout)) {
			proc.kill();
			throw new Error(`MCP server '${cmd.command}' stdin/stdout unavailable`);
		}

		// Forward server stderr to process.stderr for diagnosability.
		if (proc.stderr) {
			proc.stderr.on("data", (chunk: Buffer) => {
				process.stderr.write(`[mcp-server] ${chunk.toString()}`);
			});
		}

		const conn = new McpConnection(proc);

		// Wire up readline using 'line' events so the iterator is never consumed
		// and closed prematurely by a `for await ... return` pattern.
		const rl = createInterface({
			input: proc.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		rl.on("line", (rawLine) => {
			const trimmed = rawLine.trim();
			if (!trimmed) {
				return;
			}
			let parsed: JsonRpcFrame;
			try {
				parsed = JSON.parse(trimmed) as JsonRpcFrame;
			} catch {
				return;
			}
			// Dispatch to the matching waiter (skip notifications with no id).
			if (parsed.id === undefined || parsed.id === null) {
				return;
			}
			const idx = conn.waiters.findIndex((w) => w.id === parsed.id);
			if (idx === -1) {
				return;
			}
			const [waiter] = conn.waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			if (parsed.error) {
				waiter.reject(new Error(`MCP error: ${JSON.stringify(parsed.error)}`));
			} else {
				waiter.resolve(parsed.result ?? null);
			}
		});

		rl.on("close", () => {
			// Reject any in-flight waiters — the server exited.
			for (const waiter of conn.waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("MCP server closed the connection"));
			}
		});

		// initialize → notifications/initialized
		await conn.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "ryu-sdk", version: "0.0.1" },
		});
		conn.notify("notifications/initialized", {});

		return conn;
	}

	/** Send a JSON-RPC request and return the `result` field. */
	request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		const frame = JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params,
		});
		this.write(frame);

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`MCP request '${method}' timed out`)),
				RPC_TIMEOUT_MS
			);
			this.waiters.push({ id, resolve, reject, timer });
		});
	}

	/** Send a JSON-RPC notification (no response expected). */
	notify(method: string, params: unknown): void {
		const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
		this.write(frame);
	}

	private write(frame: string): void {
		if (this.closed) {
			return;
		}
		this.proc.stdin?.write(`${frame}\n`);
	}

	/** Graceful shutdown: close stdin, then kill. */
	async shutdown(): Promise<void> {
		this.closed = true;
		this.proc.stdin?.end();
		await new Promise<void>((resolve) => {
			this.proc.once("exit", () => resolve());
			this.proc.kill();
			// Resolve after a short grace period even if exit never fires.
			setTimeout(resolve, 500);
		});
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List the tools an MCP server advertises (`tools/list`).
 *
 * Spawns the server, completes the initialize handshake, calls `tools/list`,
 * and tears down the process — matching the stateless per-request pattern in
 * `apps/core/src/sidecar/mcp/client.rs`.
 */
export async function listTools(cmd: McpStdioCommand): Promise<McpTool[]> {
	const conn = await McpConnection.connect(cmd);
	let result: unknown;
	try {
		result = await conn.request("tools/list", {});
	} finally {
		await conn.shutdown();
	}

	const tools = (result as { tools?: unknown[] } | null)?.tools ?? [];
	return (tools as unknown[])
		.map((t) => {
			const tool = t as Record<string, unknown>;
			const name = tool.name;
			if (typeof name !== "string") {
				return null;
			}
			return {
				name,
				description:
					typeof tool.description === "string" ? tool.description : undefined,
				inputSchema: tool.inputSchema,
			} satisfies McpTool;
		})
		.filter((t): t is McpTool => t !== null);
}

/**
 * Call a tool on an MCP server (`tools/call`) and return the raw result.
 *
 * The returned value is the full `tools/call` result object
 * `{ content: [{type, text}], isError? }`.  Callers that need the plain text
 * output should extract `.content[0].text`.
 */
export async function callTool(
	cmd: McpStdioCommand,
	tool: string,
	args: unknown
): Promise<unknown> {
	const conn = await McpConnection.connect(cmd);
	try {
		return await conn.request("tools/call", { name: tool, arguments: args });
	} finally {
		await conn.shutdown();
	}
}
