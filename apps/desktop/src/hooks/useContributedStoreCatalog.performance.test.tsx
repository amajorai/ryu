import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const node = {
	token: "node-token",
	url: "http://node.test",
	userJwt: "user-one",
};
const tab = {
	app_enabled: true,
	app_installed: true,
	title: "Catalog",
	id: "catalog",
	plugin: "com.example.store",
	spec: {
		source: {
			http: { method: "GET", path: "/api/ext/com.example.store/items" },
			items: "items",
			map: { id: "id", title: "title" },
		},
	},
} satisfies PluginStoreTab;

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/client.ts", () => ({
	apiUrl: (target: typeof node, path: string) => target.url + path,
	requestHeaders: async () => ({}),
	toTarget: (target: typeof node) => target,
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	() => Promise.resolve(Response.json({ items: [] })),
	{ preconnect: originalFetch.preconnect }
);

const { useContributedStoreCatalog } = await import(
	"./useContributedStoreCatalog.ts"
);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
const root = createRoot(document.createElement("div"));

function Reader() {
	useContributedStoreCatalog(tab, true);
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
	globalThis.fetch = originalFetch;
});

test("contributed Store catalog keeps its query descriptor across renders", async () => {
	await act(() => root.render(<Harness />));
	const first = client
		.getQueryCache()
		.getAll()
		.find((query) => query.queryKey[0] === "store-tab-catalog")
		?.options.queryFn;
	expect(first).toBeDefined();

	await act(() => root.render(<Harness />));
	const second = client
		.getQueryCache()
		.getAll()
		.find((query) => query.queryKey[0] === "store-tab-catalog")
		?.options.queryFn;
	expect(second).toBe(first);
});
