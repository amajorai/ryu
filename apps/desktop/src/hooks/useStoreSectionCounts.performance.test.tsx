import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);

const node = {
	token: "node-token",
	url: "http://node.test",
	userJwt: "user-one",
};
const tab: PluginStoreTab = {
	app_enabled: true,
	app_installed: true,
	title: "Catalog",
	id: "catalog",
	plugin: "com.example.store",
};
const contributedStoreQueryFn = () => Promise.resolve({ items: [], total: 0 });

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/hooks/useAgentsCatalog.ts", () => ({
	agentCatalogQuery: () => ({
		queryFn: () => Promise.resolve([]),
		queryKey: ["test", "agents"],
	}),
}));
mock.module("@/src/hooks/useAppsCatalog.ts", () => ({
	pluginCatalogQuery: () => ({
		getNextPageParam: () => undefined,
		initialPageParam: undefined,
		queryFn: () => Promise.resolve({ entries: [], total: 0 }),
		queryKey: ["test", "plugins"],
	}),
}));
mock.module("@/src/hooks/useContributedStoreCatalog.ts", () => ({
	contributedStoreCatalogQuery: () => ({
		queryFn: contributedStoreQueryFn,
		queryKey: ["store-tab-catalog", "com.example.store", "catalog"],
	}),
}));
mock.module("@/src/hooks/useIntegrationsCatalog.ts", () => ({
	integrationsListQuery: () => ({
		getNextPageParam: () => undefined,
		initialPageParam: undefined,
		queryFn: () => Promise.resolve({ integrations: [], total: 0 }),
		queryKey: ["test", "integrations"],
	}),
}));
mock.module("@/src/hooks/useMcpCatalog.ts", () => ({
	mcpListQuery: () => ({
		getNextPageParam: () => undefined,
		initialPageParam: undefined,
		queryFn: () => Promise.resolve({ servers: [], total: 0 }),
		queryKey: ["test", "mcp"],
	}),
	mcpSourcesQuery: () => ({
		queryFn: () => Promise.resolve({ active: "" }),
		queryKey: ["test", "mcp-sources"],
	}),
}));
mock.module("@/src/hooks/useModelCatalog.ts", () => ({
	MODEL_LIST_DEFAULTS: {
		category: "chat",
		format: "all",
		installedOnly: false,
		org: "",
		query: "",
		sort: "popular",
	},
	modelListQuery: () => ({
		getNextPageParam: () => undefined,
		initialPageParam: undefined,
		queryFn: () => Promise.resolve({ models: [], total: 0 }),
		queryKey: ["test", "models"],
	}),
}));
mock.module("@/src/hooks/useSandboxBackends.ts", () => ({
	useSandboxBackends: () => ({ backends: [], loading: false }),
}));
mock.module("@/src/lib/api/skills.ts", () => ({
	searchSkillCatalogPage: () => Promise.resolve({ skills: [], total: 0 }),
}));
mock.module("@/src/lib/services-api.ts", () => ({
	fetchCatalog: () => Promise.resolve([]),
}));

const { useStoreSectionCounts } = await import("./useStoreSectionCounts.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
const root = createRoot(document.createElement("div"));
const tabs = [tab];

function Reader() {
	useStoreSectionCounts(tabs);
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
});

test("store count observers retain contributed source descriptors across renders", async () => {
	await act(() => root.render(<Harness />));
	const first = client
		.getQueryCache()
		.getAll()
		.find((query) => query.queryKey[0] === "store-tab-catalog")
		?.options.queryFn;
	expect(first).toBe(contributedStoreQueryFn);

	await act(() => root.render(<Harness />));
	const second = client
		.getQueryCache()
		.getAll()
		.find((query) => query.queryKey[0] === "store-tab-catalog")
		?.options.queryFn;
	expect(second).toBe(first);
});
