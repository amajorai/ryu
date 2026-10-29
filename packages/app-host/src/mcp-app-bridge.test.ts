import { expect, test } from "bun:test";
import { createMcpAppBridge } from "./mcp-app-bridge.ts";
import { parseModelContext, useModelContextStore } from "./model-context.ts";
import type {
	Capability,
	HostServices,
	RouteClaim,
	RpcJsonResponse,
} from "./rpc.ts";

test("SDK initialization advertises every display mode that the host can actually render", async () => {
	const sent: unknown[] = [];
	const services: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		requestDisplayMode: async ({ mode }) => ({ mode }),
	};
	const bridge = createMcpAppBridge({
		granted: new Set<Capability>(["ui.displayMode"]),
		services: () => services,
		send: (message) => sent.push(message),
	});
	await bridge.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize" });
	expect(sent.at(-1)).toMatchObject({
		result: {
			hostContext: { availableDisplayModes: ["inline", "fullscreen", "pip"] },
		},
	});
});

test("standard SDK initialization, context replacement, notifications and denied writes", async () => {
	const sent: unknown[] = [];
	const services: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		getGlobals: async () => ({
			toolInput: { selected: 1 },
			toolOutput: { content: [{ type: "text", text: "done" }] },
		}),
		updateModelContext: async (input) =>
			useModelContextStore
				.getState()
				.update("mcp", "mcp-owner", parseModelContext(input)),
		getModelContext: () =>
			useModelContextStore.getState().get("mcp", "mcp-owner"),
	};
	const bridge = createMcpAppBridge({
		granted: new Set<Capability>(["assistant.context"]),
		services: () => services,
		send: (message) => sent.push(message),
	});
	expect(
		await bridge.receive({
			jsonrpc: "2.0",
			id: 1,
			method: "ui/initialize",
			params: { protocolVersion: "2026-01-26" },
		})
	).toBe(true);
	expect(JSON.stringify(sent)).toContain("openai/modelContext");
	await bridge.receive({
		jsonrpc: "2.0",
		method: "ui/notifications/initialized",
	});
	expect(JSON.stringify(sent)).toContain("ui/notifications/tool-input");
	expect(JSON.stringify(sent)).toContain("ui/notifications/tool-result");
	await bridge.receive({
		jsonrpc: "2.0",
		id: 2,
		method: "ui/update-model-context",
		params: {
			content: [{ type: "text", text: "selected item" }],
			_meta: { private: "omitted" },
		},
	});
	expect(JSON.stringify(sent)).toContain(
		"ui/notifications/host-context-changed"
	);
	expect(JSON.stringify(services.getModelContext?.())).not.toContain("omitted");
	await bridge.receive({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "danger" },
	});
	expect(JSON.stringify(sent.at(-1))).toContain("error");
	useModelContextStore.getState().clear("mcp-owner");
});

test("does not advertise missing services and fails unknown methods visibly", async () => {
	const sent: unknown[] = [];
	const bridge = createMcpAppBridge({
		granted: new Set<Capability>(),
		services: () => ({
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		}),
		send: (message) => sent.push(message),
	});
	await bridge.receive({ jsonrpc: "2.0", id: "init", method: "ui/initialize" });
	expect(JSON.stringify(sent.at(-1))).not.toContain("updateModelContext");
	expect(sent.at(-1)).toMatchObject({
		result: { hostContext: { availableDisplayModes: ["inline"] } },
	});
	await bridge.receive({
		jsonrpc: "2.0",
		method: "ui/notifications/initialized",
	});
	await bridge.receive({ jsonrpc: "2.0", id: 2, method: "unsupported" });
	expect(sent.at(-1)).toMatchObject({ error: { code: -32_601 } });
});

test("opened resource etags, conflicts and subscriptions stay scoped", async () => {
	const sent: unknown[] = [];
	let text = "original";
	let revision = "v1";
	const services: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		readOpenedFile: async ({ uri }) => {
			if (uri !== "file:///opened.txt") {
				throw new Error("Access denied");
			}
			return { uri, text, revision };
		},
		writeOpenedFile: async ({ uri, text: next, expectedRevision }) => {
			if (next === undefined) {
				throw new Error("Only text expected in fixture");
			}
			if (uri !== "file:///opened.txt" || expectedRevision !== revision) {
				throw new Error("Conflict");
			}
			text = next;
			revision = "v2";
			return { uri, text, revision };
		},
	};
	const bridge = createMcpAppBridge({
		granted: new Set<Capability>(["file.access"]),
		services: () => services,
		send: (message) => sent.push(message),
	});
	await bridge.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize" });
	await bridge.receive({
		jsonrpc: "2.0",
		method: "ui/notifications/initialized",
	});
	await bridge.receive({
		jsonrpc: "2.0",
		id: 2,
		method: "resources/read",
		params: { uri: "file:///opened.txt" },
	});
	expect(JSON.stringify(sent.at(-1))).toContain("openai/resource");
	await bridge.receive({
		jsonrpc: "2.0",
		id: "blob-read",
		method: "resources/read",
		params: {
			uri: "file:///opened.txt",
			_meta: { "openai/resource": { representation: "blob" } },
		},
	});
	expect(JSON.stringify(sent.at(-1))).toContain("b3JpZ2luYWw=");
	await bridge.receive({
		jsonrpc: "2.0",
		id: 3,
		method: "openai/resources/write",
		params: { uri: "file:///opened.txt", text: "replacement", ifMatch: "old" },
	});
	expect(sent.at(-1)).toMatchObject({
		result: { outcome: "conflict", etag: "v1" },
	});
	expect(text).toBe("original");
	await bridge.receive({
		jsonrpc: "2.0",
		id: 4,
		method: "resources/subscribe",
		params: { uri: "file:///opened.txt" },
	});
	await bridge.receive({
		jsonrpc: "2.0",
		id: 5,
		method: "openai/resources/write",
		params: { uri: "file:///opened.txt", text: "replacement", ifMatch: "v1" },
	});
	expect(sent.at(-1)).toMatchObject({
		result: { outcome: "saved", etag: "v2" },
	});
	expect(text).toBe("replacement");
	expect(JSON.stringify(sent)).toContain("notifications/resources/updated");
	await bridge.receive({
		jsonrpc: "2.0",
		id: 6,
		method: "resources/read",
		params: { uri: "file:///other.txt" },
	});
	expect(sent.at(-1)).toHaveProperty("error");
});

function bridgeFixture(
	granted: Capability[] = [],
	overrides: Partial<HostServices> = {}
) {
	const sent: import("./mcp-app-bridge.ts").McpHostMessage[] = [];
	const services: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		...overrides,
	};
	const bridge = createMcpAppBridge({
		granted: new Set(granted),
		services: () => services,
		send: (message) => {
			sent.push(message);
		},
	});
	return { bridge, sent };
}
async function initializeBridge(bridge: ReturnType<typeof createMcpAppBridge>) {
	await bridge.receive({ jsonrpc: "2.0", id: "init", method: "ui/initialize" });
	await bridge.receive({
		jsonrpc: "2.0",
		method: "ui/notifications/initialized",
	});
}

test("wire validation ignores malformed envelopes and ids while initialization defaults remain lenient", async () => {
	const { bridge, sent } = bridgeFixture();
	for (const input of [
		null,
		[],
		{},
		{ jsonrpc: "1.0", method: "ui/initialize" },
		{ jsonrpc: "2.0", method: 7 },
	]) {
		expect(await bridge.receive(input)).toBe(false);
	}
	for (const id of [null, false, {}, []]) {
		expect(
			await bridge.receive({ jsonrpc: "2.0", id, method: "ui/initialize" })
		).toBe(true);
	}
	expect(sent).toHaveLength(0);
	await bridge.receive({
		jsonrpc: "2.0",
		id: 0,
		method: "ui/initialize",
		params: ["invalid"],
	});
	expect(sent.at(-1)).toMatchObject({
		id: 0,
		result: { protocolVersion: "2026-01-26" },
	});
	await bridge.receive({
		jsonrpc: "2.0",
		id: 1,
		method: "ui/initialize",
		params: { protocolVersion: 7 },
	});
	expect(sent.at(-1)).toMatchObject({
		id: 1,
		result: { protocolVersion: "2026-01-26" },
	});
});

test("both initialization steps gate requests and early initialized notifications do not unlock services", async () => {
	let closes = 0;
	const { bridge, sent } = bridgeFixture([], {
		requestClose: async () => {
			closes++;
		},
	});
	await bridge.receive({
		jsonrpc: "2.0",
		method: "ui/notifications/initialized",
	});
	await bridge.receive({ jsonrpc: "2.0", id: 1, method: "ui/close" });
	expect(sent.at(-1)).toMatchObject({ error: { code: -32_602 } });
	await bridge.receive({ jsonrpc: "2.0", id: 2, method: "ui/initialize" });
	await bridge.receive({ jsonrpc: "2.0", id: 3, method: "ui/close" });
	expect(sent.at(-1)).toMatchObject({ error: { code: -32_602 } });
	expect(closes).toBe(0);
	await bridge.receive({
		jsonrpc: "2.0",
		method: "ui/notifications/initialized",
	});
	await bridge.receive({ jsonrpc: "2.0", id: 4, method: "ui/close" });
	expect(sent.at(-1)).toMatchObject({ id: 4, result: {} });
	expect(closes).toBe(1);
});

test("message validation keeps text ordering and rejects unsupported roles, targets and content", async () => {
	const prompts: string[] = [];
	const { bridge, sent } = bridgeFixture(["ui.sendMessage"], {
		sendFollowUpMessage: async (input) => {
			prompts.push(input.prompt);
		},
	});
	await initializeBridge(bridge);
	const cases = [
		{ role: "assistant", content: [{ type: "text", text: "text" }] },
		{
			_meta: { "openai/message": { target: "new" } },
			content: [{ type: "text", text: "text" }],
		},
		{ content: [{ type: "image", data: "AA==" }] },
		{ content: [{ type: "text", text: 7 }] },
	];
	for (const params of cases) {
		await bridge.receive({
			jsonrpc: "2.0",
			id: 1,
			method: "ui/message",
			params,
		});
		expect(sent.at(-1)).toMatchObject({ error: { code: -32_602 } });
	}
	expect(prompts).toEqual([]);
	await bridge.receive({
		jsonrpc: "2.0",
		id: 2,
		method: "ui/message",
		params: {
			role: "user",
			_meta: { "openai/message": { target: "active" } },
			content: [
				{ type: "text", text: "first", extra: true },
				{ type: "text", text: "second" },
			],
		},
	});
	expect(prompts).toEqual(["first\nsecond"]);
	expect(sent.at(-1)).toMatchObject({ id: 2, result: {} });
});

interface McpToolOutputFixture {
	expected: import("./mcp-app-bridge.ts").McpValue;
	output: RpcJsonResponse;
}

test("tool outputs preserve MCP results and wrap JSON scalar and structured outputs", async () => {
	let output: RpcJsonResponse;
	const argumentsReceived: unknown[] = [];
	const { bridge, sent } = bridgeFixture(["tool.call"], {
		callTool: async (_name, args) => {
			argumentsReceived.push(args);
			return output;
		},
	});
	await initializeBridge(bridge);
	const results: McpToolOutputFixture[] = [
		{
			output: "plain",
			expected: { content: [{ type: "text", text: "plain" }] },
		},
		{ output: null, expected: { content: [{ type: "text", text: "null" }] } },
		{ output: 7, expected: { content: [{ type: "text", text: "7" }] } },
		{
			output: { selected: 1 },
			expected: {
				content: [{ type: "text", text: '{"selected":1}' }],
				structuredContent: { selected: 1 },
			},
		},
		{
			output: {
				content: [{ type: "text", text: "native" }],
				_meta: { private: "preserved" },
			},
			expected: {
				content: [{ type: "text", text: "native" }],
				_meta: { private: "preserved" },
			},
		},
	];
	for (const result of results) {
		output = result.output;
		await bridge.receive({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "tool" },
		});
		expect(sent.at(-1)).toMatchObject({ result: result.expected });
	}

	expect(argumentsReceived).toEqual(results.map(() => ({})));
});

test("resource conversion decodes UTF-8 and rejects an invalid representation", async () => {
	const { bridge, sent } = bridgeFixture(["file.access"], {
		readOpenedFile: async ({ uri }) => ({ uri, blob: "w6k=", revision: "v1" }),
	});
	await initializeBridge(bridge);
	await bridge.receive({
		jsonrpc: "2.0",
		id: 1,
		method: "resources/read",
		params: {
			uri: "file:///opened",
			_meta: { "openai/resource": { representation: "text" } },
		},
	});
	expect(sent.at(-1)).toMatchObject({
		result: { contents: [{ text: "é", mimeType: "text/plain" }] },
	});
	await bridge.receive({
		jsonrpc: "2.0",
		id: 2,
		method: "resources/read",
		params: {
			uri: "file:///opened",
			_meta: { "openai/resource": { representation: "invalid" } },
		},
	});
	expect(sent.at(-1)).toMatchObject({
		error: {
			code: -32_602,
			message: "Resource representation must be text or blob",
		},
	});
});

test("resource writes bound encoded bytes before accessing the file", async () => {
	let reads = 0;
	const { bridge, sent } = bridgeFixture(["file.access"], {
		readOpenedFile: async ({ uri }) => {
			reads++;
			return { uri, text: "old", revision: "v1" };
		},
	});
	await initializeBridge(bridge);
	await bridge.receive({
		jsonrpc: "2.0",
		id: 1,
		method: "openai/resources/write",
		params: { uri: "file:///opened", text: "é".repeat(1_000_001) },
	});
	expect(sent.at(-1)).toMatchObject({
		result: { outcome: "too-large", maxBytes: 2_000_000 },
	});
	expect(reads).toBe(0);
	await bridge.receive({
		jsonrpc: "2.0",
		id: 2,
		method: "openai/resources/write",
		params: { uri: "file:///opened", text: "text", blob: "AA==" },
	});
	expect(sent.at(-1)).toMatchObject({
		error: {
			code: -32_602,
			message: "A resource write requires exactly one text or blob payload",
		},
	});
	expect(reads).toBe(0);
});

test("unsubscribed resources stop producing update notifications", async () => {
	const { bridge, sent } = bridgeFixture(["file.access"], {
		readOpenedFile: async ({ uri }) => ({ uri, text: "text", revision: "v1" }),
	});
	await initializeBridge(bridge);
	await bridge.receive({
		jsonrpc: "2.0",
		id: 1,
		method: "resources/subscribe",
		params: { uri: "file:///opened" },
	});
	const globals = {
		openedFile: {
			uri: "file:///opened",
			name: "Opened",
			editable: true,
			revision: "v1",
		},
	};
	bridge.push(globals);
	expect(sent.at(-1)).toMatchObject({
		method: "notifications/resources/updated",
		params: { uri: "file:///opened" },
	});
	await bridge.receive({
		jsonrpc: "2.0",
		id: 2,
		method: "resources/unsubscribe",
		params: { uri: "file:///opened" },
	});
	bridge.push(globals);
	expect(sent.at(-1)).toMatchObject({
		method: "ui/notifications/host-context-changed",
	});
});

test("pending requests are bounded and the limit recovers after completion", async () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	let closes = 0;
	const { bridge, sent } = bridgeFixture([], {
		requestClose: async () => {
			closes++;
			await promise;
		},
	});
	await initializeBridge(bridge);
	const pending = Array.from({ length: 32 }, (_, id) =>
		bridge.receive({ jsonrpc: "2.0", id, method: "ui/close" })
	);
	await bridge.receive({ jsonrpc: "2.0", id: 33, method: "ui/close" });
	expect(sent.at(-1)).toMatchObject({ id: 33, error: { code: -32_000 } });
	expect(closes).toBe(32);
	resolve();
	await Promise.all(pending);
	await bridge.receive({ jsonrpc: "2.0", id: 34, method: "ui/close" });
	expect(sent.at(-1)).toMatchObject({ id: 34, result: {} });
	expect(closes).toBe(33);
});
