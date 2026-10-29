import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node = {
	url: "http://node.test",
	token: "node-token",
	userJwt: "user-one",
};
const requests: Array<{
	jwt: string;
	signal: AbortSignal;
	resolve: <TValue>(value: TValue) => void;
}> = [];
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/plugins.ts", () => ({
	getPluginContributions: (target: typeof node, signal: AbortSignal) =>
		new Promise((resolve) =>
			requests.push({ jwt: target.userJwt, signal, resolve })
		),
	fetchApps: () => Promise.resolve([]),
	disableApp: () => Promise.reject(new Error("unused")),
	enableApp: () => Promise.reject(new Error("unused")),
	installApp: () => Promise.reject(new Error("unused")),
	uninstallApp: () => Promise.reject(new Error("unused")),
	describeDependencyError: () => "unused",
}));
mock.module("@/src/components/views/DeclarativeView.tsx", () => ({
	HelloDeclarativeViewHarness: () => null,
}));
mock.module("@/src/contributions/registry.ts", () => ({
	contributionRegistry: {},
}));
mock.module("@/src/contributions/tab-icon-registry.ts", () => ({
	registerTabIcon: () => () => undefined,
	ruleFromItemTarget: () => null,
}));
mock.module("@/src/lib/realtime/use-realtime-room.ts", () => ({
	useRealtimeRoom: () => undefined,
}));
mock.module("@/src/pages/PluginCompanionPage.tsx", () => ({
	default: () => null,
}));
mock.module("@/src/pages/PluginViewPage.tsx", () => ({ default: () => null }));
const { usePluginContributions, usePluginContributionsQuery } = await import(
	"./usePluginContributions.ts"
);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
let root = createRoot(document.createElement("div"));
let latest: ReturnType<typeof usePluginContributionsQuery>;
function Reader() {
	latest = usePluginContributionsQuery();
	return null;
}
function Harness() {
	return (
		<QueryClientProvider client={client}>
			<Reader />
			<Reader />
		</QueryClientProvider>
	);
}
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	requests.length = 0;
	root = createRoot(document.createElement("div"));
});
test("mounts share a read while changed credentials cancel and isolate pending contributions", async () => {
	await act(async () => root.render(<Harness />));
	expect(requests).toHaveLength(1);
	expect(requests[0].jwt).toBe("user-one");
	node = { ...node, userJwt: "user-two" };
	await act(async () => root.render(<Harness />));
	expect(requests).toHaveLength(2);
	expect(requests[0].signal.aborted).toBe(true);
	expect(requests[1].jwt).toBe("user-two");
	await act(async () => {
		requests[0].resolve({ companions: [{ id: "old" }] });
		requests[1].resolve({ companions: [{ id: "current" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(latest!.data?.companions.map((item) => item.id)).toEqual(["current"]);
	await act(async () => root.render(<Harness />));
	expect(requests).toHaveLength(2);
});

test("data-only readers ignore background query status changes", async () => {
	let renders = 0;
	function DataReader() {
		usePluginContributions();
		renders += 1;
		return null;
	}

	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<DataReader />
				<DataReader />
			</QueryClientProvider>
		)
	);
	expect(requests).toHaveLength(1);
	const beforeData = renders;
	const payload = { companions: [{ id: "stable" }] };
	await act(async () => {
		requests[0].resolve(payload);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(renders).toBeGreaterThan(beforeData);
	const afterData = renders;

	await act(async () => {
		void client.invalidateQueries({ queryKey: ["plugin-contributions"] });
	});
	expect(requests).toHaveLength(2);
	// The observer is interested in `data` only, so the refetching status does
	// not rebuild a data-only contribution consumer.
	expect(renders).toBe(afterData);
	await act(async () => {
		requests[1].resolve(payload);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(renders).toBe(afterData);
});
