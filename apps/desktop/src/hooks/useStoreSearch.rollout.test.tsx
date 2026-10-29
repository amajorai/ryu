import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogEntry } from "@/src/lib/api/plugins.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const flags = new Map<string, boolean>();

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => ({
		token: "node-token",
		url: "http://node.test",
		userJwt: "user-one",
	}),
}));
mock.module("@/src/lib/feature-flags.ts", () => ({
	featureFlagScopeKey: () => "fixture-scope",
	isFeatureFlagStale: () => false,
	readFeatureFlag: (key: string) => flags.get(key),
	refreshFeatureFlags: () => Promise.resolve(),
	subscribeFeatureFlagPublications: () => () => undefined,
	subscribeFeatureFlagScope: () => () => undefined,
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

let catalog: CatalogEntry[] = [];
let installedIds: string[] = [];
mock.module("@/src/lib/api/plugins.ts", () => ({
	fetchApps: () =>
		Promise.resolve(installedIds.map((id) => ({ id, installed: true }))),
	fetchAppsCatalog: () => Promise.resolve(catalog),
}));
mock.module("@/src/lib/api/skills.ts", () => ({
	searchSkills: () => Promise.resolve([]),
}));

function app(id: string, name: string): CatalogEntry {
	return {
		description: "Birthdays and lists for a family",
		id,
		kinds: ["companion"],
		name,
		tags: ["birthdays"],
		type: "app",
	} as unknown as CatalogEntry;
}

const { useStoreSearch } = await import("./useStoreSearch.ts");
let latest: string[] = [];
let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root = createRoot(document.createElement("div"));

function Reader() {
	const { groups } = useStoreSearch("birthday");
	latest = groups.flatMap((group) => group.items.map((item) => item.id));
	return null;
}

async function search(): Promise<string[]> {
	await act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Reader />
			</QueryClientProvider>
		)
	);
	// Past the search debounce, then let the catalog query settle.
	await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
	await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
	return latest;
}

afterEach(async () => {
	await act(() => root.unmount());
	client.clear();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root = createRoot(document.createElement("div"));
	flags.clear();
	installedIds = [];
	latest = [];
});

test("Store search hides a rollout-gated app until its flag is on", async () => {
	catalog = [app("@ryu/family", "Family"), app("@ryu/open", "Open")];
	expect(await search()).toEqual(["@ryu/open"]);
});

test("Store search lists a gated app once the rollout reaches the reader", async () => {
	flags.set("family.hub", true);
	catalog = [app("@ryu/family", "Family")];
	expect(await search()).toEqual(["@ryu/family"]);
});

test("Store search keeps an installed copy of a gated app", async () => {
	installedIds = ["@ryu/family"];
	catalog = [app("@ryu/family", "Family")];
	expect(await search()).toEqual(["@ryu/family"]);
});
