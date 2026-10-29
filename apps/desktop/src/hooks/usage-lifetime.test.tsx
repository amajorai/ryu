import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PiCatalog } from "@/src/lib/api/pi-config.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node = { url: "https://node.test", token: "one", userJwt: "caller-one" };
let accountTabActive = true;
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useIsActiveTab: () => accountTabActive,
}));
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));
const reads: Array<{
	kind: string;
	signal: AbortSignal;
	resolve: <TValue>(value: TValue) => void;
}> = [];
const realUsage = await import("@ryuhq/core-client/usage.ts");
mock.module("@/src/lib/api/usage.ts", () => ({
	subscriptionQueryKeys: realUsage.subscriptionQueryKeys,
	fetchConversationProviderAccount: () => new Promise(() => undefined),
	supportsUsage: (id: string) => id === "acp:codex" || id === "claude-pro-max",
	usageSnapshotFromReading: (reading: { providerId: string }) => ({
		agentId: reading.providerId,
	}),
	fetchAgentUsage: (
		_target: Parameters<
			typeof import("@/src/lib/api/usage.ts").fetchAgentUsage
		>[0],
		_id: string,
		signal: AbortSignal
	) => new Promise((resolve) => reads.push({ kind: "agent", signal, resolve })),
	fetchSubscriptionsSnapshot: (
		_target: Parameters<
			typeof import("@/src/lib/api/usage.ts").fetchSubscriptionsSnapshot
		>[0],
		opts: { signal: AbortSignal; usage: string }
	) =>
		new Promise((resolve) =>
			reads.push({
				kind: `subscriptions:${opts.usage}`,
				signal: opts.signal,
				resolve,
			})
		),
	fetchProviderUsageReading: (
		_target: Parameters<
			typeof import("@/src/lib/api/usage.ts").fetchProviderUsageReading
		>[0],
		opts: { signal: AbortSignal }
	) =>
		new Promise((resolve) =>
			reads.push({ kind: "reading", signal: opts.signal, resolve })
		),
}));
const { useAgentUsage } = await import("./useAgentUsage.ts");
const { useSubscriptionUsage } = await import("./useSubscriptionUsage.ts");
const catalog: PiCatalog = {
	apiTypes: [],
	thinkingLevels: [],
	providers: [
		{
			id: "codex",
			label: "Codex",
			authKind: "subscription",
			managed: false,
			api: "openai-responses",
			authEnv: "",
			configured: true,
			custom: false,
			routing: "direct",
			suggestedModels: [],
			accounts: [
				{
					accountId: "one",
					label: "One",
					kind: "oauth",
					active: true,
					gatewayActive: false,
					updatedAt: 0,
				},
			],
		},
	],
};
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = createRoot(document.createElement("div"));
function Agent({ active }: { active: boolean }) {
	useAgentUsage("acp:codex", active);
	return null;
}
function Accounts() {
	useSubscriptionUsage(catalog);
	return null;
}
const render = async (active: boolean, accounts = false) => {
	await act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Agent active={active} />
				<Agent active={active} />
				{accounts && <Accounts />}
			</QueryClientProvider>
		)
	);
	await act(async () => {
		await Bun.sleep(10);
	});
};
afterEach(async () => {
	await act(() => root.unmount());
	client.clear();
});
test("inactive usage observers stay quiet, cancel on hide and separate credential scopes", async () => {
	await render(false);
	expect(reads).toHaveLength(0);
	await render(true);
	expect(reads).toHaveLength(1);
	await render(false);
	expect(reads[0].signal.aborted).toBe(true);
	await render(true, true);
	expect(reads).toHaveLength(3);
	const snapshotQueries = () =>
		client
			.getQueryCache()
			.getAll()
			.filter(
				(query) =>
					query.queryKey[0] === "subscriptions" &&
					query.queryKey.at(-1) === "refresh"
			);
	expect(snapshotQueries()).toHaveLength(1);
	await render(true, true);
	expect(reads).toHaveLength(3);
	expect(snapshotQueries()).toHaveLength(1);
	const settle = (read: (typeof reads)[number]) =>
		read.resolve(
			read.kind.startsWith("subscriptions")
				? { version: 1, generatedAt: "", providers: [] }
				: { available: true }
		);
	await act(async () => {
		settle(reads[1]);
		settle(reads[2]);
		await Bun.sleep(10);
	});
	node = { ...node, token: "two" };
	await render(true, true);
	expect(reads).toHaveLength(5);
	expect(
		reads
			.slice(3)
			.map((read) => read.kind)
			.sort()
	).toEqual(["agent", "subscriptions:refresh"]);
	node = { ...node, userJwt: "caller-two" };
	await render(true, true);
	expect(reads).toHaveLength(7);
	expect(reads[3].signal.aborted).toBe(true);
	expect(reads[4].signal.aborted).toBe(true);
	accountTabActive = false;
	await render(false, true);
	expect(reads[6].signal.aborted).toBe(true);
	expect(
		client
			.getQueryCache()
			.getAll()
			.every((query) => query.getObserversCount() === 0)
	).toBe(true);
	accountTabActive = true;
	await render(false, true);
	expect(reads).toHaveLength(8);
	await act(async () => {
		settle(reads[7]);
		await Bun.sleep(10);
	});
	accountTabActive = false;
	await render(false, true);
	accountTabActive = true;
	await render(false, true);
	expect(reads).toHaveLength(8);
});

function ProviderAgent() {
	useAgentUsage("claude-pro-max");
	return null;
}
test("a Ryu provider id reads its active account, never the agent route", async () => {
	reads.length = 0;
	const providerRoot = createRoot(document.createElement("div"));
	await act(() =>
		providerRoot.render(
			<QueryClientProvider client={client}>
				<ProviderAgent />
			</QueryClientProvider>
		)
	);
	await act(async () => {
		await Bun.sleep(10);
	});
	expect(reads.map((read) => read.kind)).toEqual(["subscriptions:none"]);
	await act(async () => {
		reads[0].resolve({
			version: 1,
			generatedAt: "",
			providers: [
				{
					providerId: "claude-pro-max",
					kind: "subscription",
					capabilities: { accountUsage: true },
					accounts: [],
				},
			],
		});
		await Bun.sleep(10);
	});
	expect(reads.map((read) => read.kind)).toEqual([
		"subscriptions:none",
		"reading",
	]);
	await act(() => providerRoot.unmount());
});
