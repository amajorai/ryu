/**
 * MCP client+server bridge round-trip tests.
 *
 * Criterion coverage:
 * 1. SDK MCP client can `initialize` + `tools/list` + `tools/call` against a
 *    stdio MCP server matching the wire contract in client.rs.
 * 2. SDK MCP server registers Runnables and serves them via tools/list +
 *    tools/call over stdio.
 * 3. A round-trip test starts the SDK MCP server, lists tools, calls one
 *    Runnable tool, and asserts the result matches a direct run().
 * 4. The bridge does NOT implement tool-approval or policy (left to
 *    chat/Gateway per #86) — documented in server.ts; no approval code here.
 */

import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, listTools } from "./client.ts";
import type { SdkRunnable } from "./server.ts";
import { McpServer, unwrapContent } from "./server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixture-server.ts");

/** Command descriptor that spawns the fixture server via `bun run`. */
const fixtureCmd = { command: "bun", args: ["run", FIXTURE] };

// ── Criterion 1 + 2: client against SDK server ────────────────────────────────

describe("MCP client", () => {
	it("lists tools from the fixture server", async () => {
		const tools = await listTools(fixtureCmd);
		expect(tools.length).toBeGreaterThan(0);
		const greet = tools.find((t) => t.name === "greet");
		expect(greet).toBeDefined();
		expect(greet?.description).toContain("greeting");
	});

	it("calls a tool on the fixture server", async () => {
		const result = await callTool(fixtureCmd, "greet", { name: "Ryu" });
		// result is the raw MCP tools/call envelope
		const value = unwrapContent(result);
		expect(value).toEqual({ message: "Hello, Ryu!" });
	});
});

// ── Criterion 3: round-trip — client result matches direct run() ──────────────

describe("MCP bridge round-trip", () => {
	it("client callTool result matches direct runnable.run()", async () => {
		// Define the same Runnable that the fixture server registers.
		const runnable: SdkRunnable = {
			name: "greet",
			run: (args: unknown) => {
				const a = args as { name?: string };
				return Promise.resolve({ message: `Hello, ${a.name ?? "world"}!` });
			},
		};

		const inputArgs = { name: "Bridge" };

		// Direct run.
		const directResult = await runnable.run(inputArgs);

		// Via MCP round-trip through the fixture server.
		const rawResult = await callTool(fixtureCmd, "greet", inputArgs);
		const roundTripResult = unwrapContent(rawResult);

		expect(roundTripResult).toEqual(directResult);
	});
});

// ── McpServer.serve() in-process ──────────────────────────────────────────────

describe("McpServer.serve()", () => {
	/**
	 * Helper: feed a sequence of JSON-RPC lines into an McpServer via piped
	 * streams and collect all output lines.
	 */
	async function runInProcess(
		server: McpServer,
		lines: string[]
	): Promise<string[]> {
		const { Readable, Writable } = await import("node:stream");

		const inputLines = [...lines].map((l) => `${l}\n`).join("");

		const input = Readable.from([inputLines]);
		const outputLines: string[] = [];
		const output = new Writable({
			write(chunk, _enc, cb) {
				const text: string = chunk.toString();
				for (const line of text.split("\n")) {
					const t = line.trim();
					if (t) {
						outputLines.push(t);
					}
				}
				cb();
			},
		});

		await server.serve(input, output);
		return outputLines;
	}

	it("responds to initialize", async () => {
		const server = new McpServer();
		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "test", version: "0" },
				},
			}),
		]);

		expect(outputs.length).toBeGreaterThan(0);
		const resp = JSON.parse(outputs[0] as string);
		expect(resp.id).toBe(1);
		expect(resp.result?.protocolVersion).toBe("2024-11-05");
		expect(resp.result?.capabilities?.tools).toBeDefined();
	});

	it("lists registered runnables via tools/list", async () => {
		const server = new McpServer().register({
			name: "ping",
			description: "Ping tool",
			run: async () => "pong",
		});

		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {} },
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: {},
			}),
		]);

		const listResp = outputs.map((l) => JSON.parse(l)).find((r) => r.id === 2);
		expect(listResp).toBeDefined();
		const tools = listResp.result?.tools as { name: string }[];
		expect(tools.some((t) => t.name === "ping")).toBe(true);
	});

	it("calls a registered runnable via tools/call", async () => {
		const server = new McpServer().register({
			name: "add",
			run: (args: unknown) => {
				const a = args as { x: number; y: number };
				return Promise.resolve(a.x + a.y);
			},
		});

		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {} },
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "add", arguments: { x: 3, y: 4 } },
			}),
		]);

		const callResp = outputs.map((l) => JSON.parse(l)).find((r) => r.id === 3);
		expect(callResp).toBeDefined();
		const value = unwrapContent(callResp.result);
		expect(value).toBe(7);
	});
});
