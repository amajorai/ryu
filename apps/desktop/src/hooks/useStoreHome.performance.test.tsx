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
const queryReads: Array<{
	realm: string;
	target?: unknown;
	options?: unknown;
}> = [];
function readRealm(
	realm: string,
	value: unknown,
	target?: unknown,
	options?: unknown
): Promise<unknown> {
	queryReads.push({ realm, target, options });
	return Promise.resolve(value);
}

const clientApi = await import("@/src/lib/api/client.ts");
const modelApi = await import("@/src/lib/api/models.ts");

mock.module("@/src/components/skills/SkillDistributionProvider.tsx", () => ({
	useSkillDistributionFlow: () => ({
		confirmSkillSetChange: () => Promise.resolve(true),
		installCatalogSkill: () => Promise.resolve(),
	}),
}));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/agents.ts", () => ({
	fetchAgentCatalog: (target: unknown) => readRealm("agents", [], target),
	installAgent: () => Promise.resolve(),
}));
mock.module("@/src/lib/api/client.ts", () => ({
	...clientApi,
	request: (target: unknown, path: string) =>
		readRealm("recommendations", {}, target, { path }),
}));
mock.module("@/src/lib/api/gateway.ts", () => ({
	updateGatewayConfig: () => Promise.resolve(),
}));
mock.module("@/src/lib/api/mcp.ts", () => ({
	installMcpServer: () => Promise.resolve(),
	searchMcpCatalog: (target: unknown, options: unknown) =>
		readRealm("mcp", { servers: [] }, target, options),
}));
mock.module("@/src/lib/api/models.ts", () => ({
	...modelApi,
	fetchModelDetail: () =>
		Promise.reject(new Error("Browse must not read install details")),
	installModelFile: () =>
		Promise.reject(new Error("Browse must not install a model")),
	installModelSnapshot: () => Promise.resolve(),
	searchModels: (target: unknown, options: unknown) =>
		readRealm("models", { models: [] }, target, options),
}));
mock.module("@/src/lib/api/plugins.ts", () => ({
	fetchApps: (target: unknown) => readRealm("installed-apps", [], target),
	fetchAppsCatalog: (target: unknown) => readRealm("apps", [], target),
	installApp: () => Promise.resolve(),
	installPluginFromCatalog: () => Promise.resolve(),
}));
mock.module("@/src/lib/api/skills.ts", () => ({
	searchSkills: (target: unknown, options: unknown) =>
		readRealm("skills", [], target, options),
}));

const { useStoreHome } = await import("./useStoreHome.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
let root = createRoot(document.createElement("div"));

function Reader() {
	useStoreHome();
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
	queryReads.length = 0;
	root = createRoot(document.createElement("div"));
});

test("Store Home retains its seven realm query descriptors across renders", async () => {
	await act(() => root.render(<Harness />));
	const keys = new Set(["store-home", "apps", "agents"]);
	const first = client
		.getQueryCache()
		.getAll()
		.filter((query) => keys.has(String(query.queryKey[0])))
		.sort((a, b) => String(a.queryKey).localeCompare(String(b.queryKey)))
		.map((query) => query.options.queryFn);
	expect(first).toHaveLength(7);
	expect(queryReads.map((read) => read.realm).sort()).toEqual([
		"agents",
		"apps",
		"installed-apps",
		"mcp",
		"models",
		"recommendations",
		"skills",
	]);
	for (const read of queryReads) {
		expect(read.target).toEqual(node);
		if (["mcp", "models", "skills"].includes(read.realm)) {
			expect(read.options).toMatchObject({ limit: 12 });
		}
	}
	const firstReads = [...queryReads];

	await act(() => root.render(<Harness />));
	const second = client
		.getQueryCache()
		.getAll()
		.filter((query) => keys.has(String(query.queryKey[0])))
		.sort((a, b) => String(a.queryKey).localeCompare(String(b.queryKey)))
		.map((query) => query.options.queryFn);
	expect(second).toEqual(first);
	expect(queryReads).toEqual(firstReads);
});
