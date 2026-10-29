import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const node = {
	token: "node-token",
	url: "http://node.test",
	userJwt: "user-one",
};

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/agents.ts", () => ({
	fetchAgentCatalog: () => Promise.resolve([]),
}));
mock.module("@/src/lib/api/mcp.ts", () => ({
	searchMcpCatalog: () => Promise.resolve({ servers: [] }),
}));
mock.module("@/src/lib/api/models.ts", () => ({
	searchModels: () => Promise.resolve({ models: [] }),
}));
mock.module("@/src/lib/api/plugins.ts", () => ({
	fetchApps: () => Promise.resolve([]),
	fetchAppsCatalog: () => Promise.resolve([]),
}));
mock.module("@/src/lib/api/skills.ts", () => ({
	searchSkills: () => Promise.resolve([]),
}));

const { useStoreSearch } = await import("./useStoreSearch.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
let root = createRoot(document.createElement("div"));

function Reader() {
	useStoreSearch("");
	return null;
}

function Harness() {
	return (
		<QueryClientProvider client={client}>
			<Reader />
		</QueryClientProvider>
	);
}

afterEach(async () => {
	await act(() => root.unmount());
	client.clear();
	root = createRoot(document.createElement("div"));
});

test("Store-wide search retains all six query descriptors across shell renders", async () => {
	await act(() => root.render(<Harness />));
	const keys = new Set(["store-search", "apps", "agents"]);
	const first = client
		.getQueryCache()
		.getAll()
		.filter((query) => keys.has(String(query.queryKey[0])))
		.sort((a, b) => String(a.queryKey).localeCompare(String(b.queryKey)))
		.map((query) => query.options.queryFn);
	// Five realm feeds plus the installed-apps list the rollout gate joins.
	expect(first).toHaveLength(6);

	await act(() => root.render(<Harness />));
	const second = client
		.getQueryCache()
		.getAll()
		.filter((query) => keys.has(String(query.queryKey[0])))
		.sort((a, b) => String(a.queryKey).localeCompare(String(b.queryKey)))
		.map((query) => query.options.queryFn);
	expect(second).toEqual(first);
});
