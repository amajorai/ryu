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
mock.module("@/src/lib/api/marketplace.ts", () => ({
	fetchInstalledPortablePackages: () => Promise.resolve([]),
	installPortablePackage: () => Promise.resolve(),
	setPortablePackageEnabled: () => Promise.resolve(),
}));
mock.module("@/src/lib/api/plugins.ts", () => ({
	addMarketplaceSource: () => Promise.resolve(),
	fetchApps: () => Promise.resolve([]),
	fetchPluginCatalogDetail: () => Promise.resolve(null),
	fetchPluginSources: () => Promise.resolve({ sources: [] }),
	searchPluginCatalog: () => Promise.resolve({ entries: [], nextCursor: null }),
	updateInstalledPlugin: () => Promise.resolve(),
	updateInstalledPluginAtVersion: () => Promise.resolve(),
	installApp: () => Promise.resolve(),
	installAppFromUrl: () => Promise.resolve(),
	installPluginFromCatalog: () => Promise.resolve(),
	installPluginFromCatalogAtVersion: () => Promise.resolve(),
	enableApp: () => Promise.resolve(),
	disableApp: () => Promise.resolve(),
}));

const { useAppsCatalog } = await import("./useAppsCatalog.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
let root = createRoot(document.createElement("div"));

function Reader() {
	useAppsCatalog();
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

test("Apps catalog retains its five query descriptors across renders", async () => {
	await act(() => root.render(<Harness />));
	const keys = new Set(["plugins", "apps", "marketplace"]);
	const first = client
		.getQueryCache()
		.getAll()
		.filter((query) => keys.has(String(query.queryKey[0])))
		.sort((a, b) => String(a.queryKey).localeCompare(String(b.queryKey)))
		.map((query) => query.options.queryFn);
	expect(first).toHaveLength(5);

	await act(() => root.render(<Harness />));
	const second = client
		.getQueryCache()
		.getAll()
		.filter((query) => keys.has(String(query.queryKey[0])))
		.sort((a, b) => String(a.queryKey).localeCompare(String(b.queryKey)))
		.map((query) => query.options.queryFn);
	expect(second).toEqual(first);
});
