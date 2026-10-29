import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { notifyManager, QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
});
const reads: Array<(agents: Array<{ id: string; name: string }>) => void> = [];
let identity: string | null = null;
let holdEngines = false;
mock.module("@/src/lib/query-client.ts", () => ({ queryClient: client }));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => ({
		url: "https://proof.example",
		token: null,
		userJwt: identity,
	}),
}));
mock.module("@/src/lib/gating/useEntityCap.ts", () => ({
	useEntityCap: () => ({
		guard: () => true,
		limitFor: () => Number.POSITIVE_INFINITY,
	}),
}));
mock.module("@/src/lib/agent-persona.ts", () => ({
	personaToGlyphValue: () => null,
}));
mock.module("@/src/lib/api/agents.ts", () => ({
	fetchAgents: () => new Promise((resolve) => reads.push(resolve)),
	createAgent: async () => ({ id: "new", name: "Created", persona: null }),
	updateAgent: async () => ({ id: "new", name: "Updated", persona: null }),
	deleteAgent: async () => undefined,
}));
mock.module("@/src/lib/api/engines.ts", () => ({
	fetchEngines: () =>
		holdEngines ? new Promise(() => {}) : Promise.resolve([]),
	fetchActiveEngine: async () => null,
}));
mock.module("@/src/lib/api/mcp.ts", () => ({
	fetchMcpServers: async () => [],
	fetchMcpTools: async () => [],
	callMcpTool: async () => ({}),
	createMcpServer: async () => ({}),
	updateMcpServer: async () => ({}),
	deleteMcpServer: async () => ({}),
}));
const { useAgents } = await import("./useAgents.ts");
const { useMcp } = await import("./useMcp.ts");
const { triggerAgentsRefresh } = await import("@/src/lib/core-refresh.ts");
let mcp: ReturnType<typeof useMcp>;
function McpReader() {
	mcp = useMcp();
	return null;
}
let result: ReturnType<typeof useAgents>;
function Harness() {
	result = useAgents();
	return null;
}
const container = document.createElement("div");
let root = createRoot(container);
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	root = createRoot(container);
	reads.length = 0;
	identity = null;
	holdEngines = false;
});
test("a mutation that beats initial loading remains visible and recovers the full roster", async () => {
	await act(async () => root.render(<Harness />));
	expect(reads).toHaveLength(1);
	await act(async () => {
		await result.create({
			name: "Created",
			description: null,
			engine: null,
			systemPrompt: null,
			tools: [],
		});
	});
	expect(result.agents[0]?.name).toBe("Created");
	expect(result.loading).toBe(false);
	expect(reads).toHaveLength(2);
	await act(async () => reads[0]([{ id: "old", name: "Stale initial read" }]));
	expect(result.agents[0]?.name).toBe("Created");
	await act(async () =>
		reads[1]([
			{ id: "new", name: "Created" },
			{ id: "existing", name: "Existing" },
		])
	);
	expect(result.agents.map((agent) => agent.name)).toEqual([
		"Created",
		"Existing",
	]);
});

test("identities on the same node cannot reuse each others roster", async () => {
	identity = "user-a";
	await act(async () => root.render(<Harness />));
	await act(async () => reads[0]([{ id: "a", name: "User A agent" }]));
	identity = "user-b";
	await act(async () => root.render(<Harness />));
	expect(result.agents).toEqual([]);
	expect(reads).toHaveLength(2);
	await act(async () => reads[1]([{ id: "b", name: "User B agent" }]));
	expect(result.agents[0]?.name).toBe("User B agent");
	identity = "user-a";
	await act(async () => root.render(<Harness />));
	expect(result.agents[0]?.name).toBe("User A agent");
	expect(reads).toHaveLength(2);
});

const input = {
	name: "Created",
	description: null,
	engine: null,
	systemPrompt: null,
	tools: [],
};
test("roster and MCP consumers share reads and immediate create, edit and delete results", async () => {
	await act(async () =>
		root.render(
			<>
				<Harness />
				<McpReader />
			</>
		)
	);
	expect(reads).toHaveLength(1);
	await act(async () => reads[0]([]));
	await act(async () => {
		await result.create(input);
	});
	expect(mcp.agents[0]?.name).toBe("Created");
	await act(async () => {
		await result.update("new", input);
	});
	expect(mcp.agents[0]?.name).toBe("Updated");
	await act(async () => {
		await result.remove("new");
	});
	expect(mcp.agents).toEqual([]);
	expect(reads).toHaveLength(1);
});
test("Store roster refresh reaches MCP even without a mounted chat roster", async () => {
	await act(async () => root.render(<McpReader />));
	await act(async () => reads[0]([{ id: "a", name: "Before" }]));
	await act(async () => triggerAgentsRefresh());
	expect(reads).toHaveLength(2);
	await act(async () => reads[1]([{ id: "a", name: "After" }]));
	expect(mcp.agents[0]?.name).toBe("After");
});

test("slow engine metadata does not delay a ready roster", async () => {
	holdEngines = true;
	await act(async () => root.render(<Harness />));
	await act(async () => reads[0]([{ id: "ready", name: "Ready agent" }]));
	expect(result.loading).toBe(false);
	expect(result.agents[0]?.name).toBe("Ready agent");
	expect(result.engines).toEqual([]);
});

test("Store refresh replaces a pending initial roster instead of accepting its stale result", async () => {
	await act(async () => root.render(<McpReader />));
	await act(async () => triggerAgentsRefresh());
	expect(reads).toHaveLength(2);
	await act(async () => reads[0]([{ id: "a", name: "Stale" }]));
	expect(mcp.agents).toEqual([]);
	await act(async () => reads[1]([{ id: "a", name: "Installed" }]));
	expect(mcp.agents[0]?.name).toBe("Installed");
});
