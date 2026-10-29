import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);

const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
});
let node = {
	token: "node-token",
	url: "http://node.test",
	userJwt: "user-one",
};

mock.module("@/src/components/updater/AutoUpdater.tsx", () => ({
	applyReleaseUpdate: async () => null,
}));
mock.module("@/src/lib/api/agents.ts", () => ({
	fetchAgentCatalog: async () => [],
	runAgentUpdate: async () => ({ updated: false }),
}));
mock.module("@/src/lib/api/client.ts", () => ({
	toTarget: (value: typeof node) => ({ ...value }),
}));
mock.module("@/src/lib/api/mcp.ts", () => ({
	installMcpServer: async () => undefined,
	listMcpUpdates: async () => [],
}));
mock.module("@/src/lib/api/models.ts", () => ({
	installModelFile: async () => undefined,
	listModelUpdates: async () => [],
}));
mock.module("@/src/lib/api/plugins.ts", () => ({
	fetchApps: async () => [],
	fetchAppsCatalog: async () => [],
	updateInstalledPlugin: async () => ({ version: null }),
}));
mock.module("@/src/lib/api/skills.ts", () => ({
	installSkill: async () => undefined,
	listSkillUpdates: async () => [],
}));
mock.module("@/src/lib/api/update.ts", () => ({
	checkForUpdate: async () => ({
		current: "1.0.0",
		latest: "1.0.0",
		update_available: false,
	}),
	updateCheckFailed: () => false,
}));
mock.module("@/src/lib/app-version.ts", () => ({
	getAppVersion: async () => "1.0.0",
	isNewerVersion: () => false,
	releaseIsNewerThanApp: () => false,
}));
mock.module("@/src/lib/services-api.ts", () => ({
	fetchCatalog: async () => [],
	installSidecar: async () => undefined,
}));
mock.module("@/src/store/useNodeStore.ts", () => ({
	isLocalNode: () => true,
	useNodeStore: <TResult,>(
		selector: (state: { getActiveNode: () => typeof node }) => TResult
	) => selector({ getActiveNode: () => node }),
}));
mock.module("sileo", () => ({
	sileo: { error: () => undefined, success: () => undefined },
}));

const { useAvailableUpdates } = await import("./useAvailableUpdates.ts");
let latest: ReturnType<typeof useAvailableUpdates>;
let root = createRoot(document.createElement("div"));

function Reader() {
	latest = useAvailableUpdates();
	return null;
}

function Harness() {
	return (
		<QueryClientProvider client={client}>
			<Reader />
		</QueryClientProvider>
	);
}

const flush = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	root = createRoot(document.createElement("div"));
	node = { ...node, userJwt: "user-one" };
});

test("download-center update observers keep stable descriptors across renders", async () => {
	await act(async () => root.render(<Harness />));
	await flush();
	const queries = client
		.getQueryCache()
		.getAll()
		.filter((query) =>
			[
				"update",
				"agents",
				"catalog",
				"apps",
				"plugins",
				"models",
				"skills",
				"mcp",
				"app",
			].includes(String(query.queryKey[0]))
		);
	expect(queries).toHaveLength(9);
	const queryFns = queries.map((query) => query.options.queryFn);

	await act(async () => root.render(<Harness />));
	await flush();
	expect(latest.updates).toEqual([]);
	expect(
		client
			.getQueryCache()
			.getAll()
			.filter((query) =>
				[
					"update",
					"agents",
					"catalog",
					"apps",
					"plugins",
					"models",
					"skills",
					"mcp",
					"app",
				].includes(String(query.queryKey[0]))
			)
			.map((query) => query.options.queryFn)
	).toEqual(queryFns);
});
