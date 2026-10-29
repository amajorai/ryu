import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { plugin } from "bun";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PiCatalog } from "@/src/lib/api/pi-config.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const candidate = process.env.RYU_RENAME_HOOK_SOURCE;
if (candidate) {
	plugin({
		name: "rename-candidate-source",
		setup(build) {
			build.onLoad({ filter: /useLlmProviders\.ts$/ }, async () => ({
				contents: await readFile(candidate, "utf8"),
				loader: "ts",
			}));
		},
	});
}
const node = {
	name: "rename-owner",
	url: "http://node-a.test",
	token: null,
	userJwt: null,
};
const initial: PiCatalog = { providers: [], apiTypes: [], thinkingLevels: [] };
const renamed: PiCatalog = {
	...initial,
	providers: [
		{
			id: "custom/provider",
			label: "Custom provider",
			api: "openai-completions",
			authEnv: "",
			authKind: "api-key",
			configured: true,
			custom: true,
			routing: "direct",
			suggestedModels: [],
			accounts: [
				{
					accountId: "account-one",
					label: "Work",
					active: true,
					gatewayActive: false,
					kind: "api_key",
					updatedAt: 1,
				},
			],
		},
	],
};
const calls: { url: string; path: string; method?: string; body?: unknown }[] =
	[];
let rejectRename = false;
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));
mock.module("../lib/api/client.ts", () => ({
	toTarget: (value: typeof node) => value,
	apiUrl: (target: typeof node, path: string) => `${target.url}${path}`,
	request: async (
		target: typeof node,
		path: string,
		options?: { method?: string; body?: unknown }
	) => {
		calls.push({ url: target.url, path, ...options });
		if (path.endsWith("/accounts/rename")) {
			if (rejectRename) {
				throw new Error("Rename rejected");
			}
			return renamed;
		}
		return path.endsWith("/catalog")
			? initial
			: {
					config: {
						provider: "openai",
						model: null,
						configDir: "owned-rename-test",
						routing: "direct",
						thinkingLevel: null,
					},
				};
	},
}));
const { useLlmProviders } = await import("./useLlmProviders.ts");
let live: ReturnType<typeof useLlmProviders> | null = null;
function Probe() {
	live = useLlmProviders();
	return null;
}
function current() {
	if (!live) {
		throw new Error("Provider hook did not mount");
	}
	return live;
}

test("rename posts account identity and label, updates the shared catalog, and invalidates only its node config", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const unrelated = { provider: "untouched" };
	client.setQueryData(["pi-config", "http://node-b.test"], unrelated);
	const invalidated: unknown[][] = [];
	const invalidate = client.invalidateQueries.bind(client);
	client.invalidateQueries = (filters, options) => {
		if (filters?.queryKey) {
			invalidated.push([...filters.queryKey]);
		}
		return invalidate(filters, options);
	};
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<Probe />
				</QueryClientProvider>
			);
			await Bun.sleep(10);
		});
		await act(async () => {
			await current().renameAccount("custom/provider", "account-one", "Work");
		});
		expect(
			calls.find((call) => call.path.endsWith("/accounts/rename"))
		).toEqual({
			url: node.url,
			path: "/api/pi-config/providers/custom%2Fprovider/accounts/rename",
			method: "POST",
			body: { accountId: "account-one", label: "Work" },
		});
		expect(current().catalog).toEqual(renamed);
		const currentConfigKeys = client
			.getQueryCache()
			.findAll({ queryKey: ["pi-config", node.url] })
			.map((query) => query.queryKey);
		expect(currentConfigKeys).toHaveLength(1);
		const configKey = currentConfigKeys[0];
		if (!configKey) throw new Error("Missing active provider config query");
		expect(invalidated).toContainEqual([...configKey]);
		expect(
			client.getQueryState(["pi-config", "http://node-b.test"])?.isInvalidated
		).toBe(false);
		expect(
			client.getQueryData<typeof unrelated>(["pi-config", "http://node-b.test"])
		).toEqual(unrelated);
		rejectRename = true;
		await expect(
			current().renameAccount("custom/provider", "account-one", "Rejected")
		).rejects.toThrow("Rename rejected");
		expect(current().catalog).toEqual(renamed);
	} finally {
		await act(() => root.unmount());
		client.clear();
	}
});
