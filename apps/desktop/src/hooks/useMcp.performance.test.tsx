import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
let node = { url: "http://node.test", token: "node-token", userJwt: "one" };
interface Read {
	jwt: string;
	kind: string;
	resolve: <TValue>(value: TValue) => void;
	signal: AbortSignal;
}
const reads: Read[] = [];
const calls: string[] = [];
const read = (kind: string, target: typeof node, signal: AbortSignal) =>
	new Promise((resolve) =>
		reads.push({ kind, jwt: target.userJwt, signal, resolve })
	);
mock.module("@/src/lib/query-client.ts", () => ({ queryClient: client }));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/core-refresh.ts", () => ({
	useCoreRefresh: () => undefined,
}));
mock.module("@/src/lib/api/agents.ts", () => ({
	fetchAgents: (target: typeof node, signal: AbortSignal) =>
		read("agents", target, signal),
}));
mock.module("@/src/lib/api/mcp.ts", () => ({
	fetchMcpServers: (target: typeof node, signal: AbortSignal) =>
		read("servers", target, signal),
	fetchMcpTools: (
		target: typeof node,
		agent: string | undefined,
		signal: AbortSignal
	) => read(`tools:${agent ?? "all"}`, target, signal),
	callMcpTool: async (target: typeof node) => {
		calls.push(target.userJwt);
		return { ok: true };
	},
	createMcpServer: async () => ({ ok: true }),
	updateMcpServer: async () => ({ ok: true }),
	deleteMcpServer: async () => ({ ok: true }),
}));
const { useMcp } = await import("./useMcp.ts");
let root = createRoot(document.createElement("div"));
let first: ReturnType<typeof useMcp>;
let second: ReturnType<typeof useMcp>;
function Reader({ slot }: { slot: "first" | "second" }) {
	const state = useMcp();
	if (slot === "first") {
		first = state;
	} else {
		second = state;
	}
	return null;
}
function Harness() {
	return (
		<>
			<Reader slot="first" />
			<Reader slot="second" />
		</>
	);
}
const settle = async (items: Read[], name = "current") =>
	act(async () => {
		for (const item of items) {
			item.resolve([{ id: name, name }]);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	root = createRoot(document.createElement("div"));
	reads.length = 0;
	calls.length = 0;
	node = { ...node, userJwt: "one" };
});
test("two consumers share three reads and agent filtering requests tools only", async () => {
	await act(async () => root.render(<Harness />));
	expect(reads).toHaveLength(3);
	const queryFns = client
		.getQueryCache()
		.getAll()
		.filter((query) =>
			["mcp-servers", "mcp-tools"].includes(String(query.queryKey[0]))
		)
		.map((query) => query.options.queryFn);
	await act(async () => root.render(<Harness />));
	expect(
		client
			.getQueryCache()
			.getAll()
			.filter((query) =>
				["mcp-servers", "mcp-tools"].includes(String(query.queryKey[0]))
			)
			.map((query) => query.options.queryFn)
	).toEqual(queryFns);
	await settle(reads);
	await act(async () => first.setAgentFilter("agent-a"));
	expect(reads).toHaveLength(4);
	expect(reads[3].kind).toBe("tools:agent-a");
	expect(second.loading).toBe(false);
	await settle([reads[3]]);
	await act(async () => first.setAgentFilter(null));
	expect(reads).toHaveLength(4);
});
test("server mutations replace pre-mutation reads without reloading agent options", async () => {
	await act(async () => root.render(<Harness />));
	let mutation = Promise.resolve({ ok: true });
	await act(async () => {
		mutation = first.createServer({
			name: "sample",
			transport: "stdio",
			command: "echo",
		});
		await Promise.resolve();
	});
	expect(reads[0].signal.aborted).toBe(true);
	expect(reads[1].signal.aborted).toBe(true);
	expect(reads.filter((item) => item.kind === "agents")).toHaveLength(1);
	await settle(reads.slice(0, 2), "stale");
	await settle(reads.slice(2), "fresh");
	await act(async () => {
		await mutation;
	});
	expect(first.servers[0].name).toBe("fresh");
});
test("credentials scope reads and tool calls, ignoring late old-node responses", async () => {
	await act(async () => root.render(<Harness />));
	node = { ...node, userJwt: "two" };
	await act(async () => root.render(<Harness />));
	expect(reads).toHaveLength(6);
	expect(reads.slice(0, 3).every((item) => item.signal.aborted)).toBe(true);
	await settle(reads.slice(0, 3), "stale");
	await settle(reads.slice(3), "fresh");
	expect(first.servers[0].name).toBe("fresh");
	await first.callTool("sample.tool", "agent", {});
	expect(calls).toEqual(["two"]);
});

test("slow optional agent options do not block registry browsing", async () => {
	await act(async () => root.render(<Harness />));
	await settle(reads.filter((item) => item.kind !== "agents"));
	expect(first.loading).toBe(false);
	expect(first.servers[0].name).toBe("current");
	expect(first.agents).toEqual([]);
});
