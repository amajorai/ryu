import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { PluginLiveActivity } from "@/src/lib/api/plugins.ts";

if (!globalThis.document) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node = { url: "https://node.test", token: "one", userJwt: "caller" };
const declaration = (id: string, refreshMs: number): PluginLiveActivity => ({
	id,
	title: id,
	plugin: "com.ryu.fixture",
	spec: {
		source: {
			http: { path: "/api/ext/com.ryu.fixture/jobs", method: "GET" },
			items: "jobs",
			map: { id: "id", title: "title" },
			refreshMs,
		},
	},
});
let contributions = [declaration("one", 5000), declaration("two", 10_000)];
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/hooks/usePluginContributions.ts", () => ({
	usePluginContributions: () => ({ live_activities: contributions }),
}));
mock.module("@/src/lib/api/client.ts", () => ({
	toTarget: (target: ApiTarget) => target,
	apiUrl: (target: ApiTarget, path: string) => target.url + path,
	requestHeaders: async () => ({}),
}));
const { useContributedLiveActivities } = await import("./contributed.ts");
const { useLiveActivityStore } = await import(
	"@/src/store/useLiveActivityStore.ts"
);
const originalFetch = globalThis.fetch;
const requests: Array<{
	signal?: AbortSignal | null;
	resolve: (response: Response) => void;
}> = [];
globalThis.fetch = Object.assign(
	(_input: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((resolve, reject) => {
			requests.push({ signal: init?.signal, resolve });
			init?.signal?.addEventListener(
				"abort",
				() => reject(new DOMException("aborted", "AbortError")),
				{ once: true }
			);
		}),
	{ preconnect: originalFetch.preconnect }
);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = createRoot(document.createElement("div"));
function Probe() {
	useContributedLiveActivities();
	return null;
}
const tick = async (action: () => void) => {
	await act(() => action());
	await act(async () => {
		await Bun.sleep(10);
	});
};
const render = () =>
	tick(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>
		)
	);
let publications = 0;
const unsubscribe = useLiveActivityStore.subscribe(() => {
	publications++;
});
const payload = { jobs: [{ id: "job", title: "Fixture job" }] };
afterEach(async () => {
	await act(() => root.unmount());
	unsubscribe();
	client.clear();
	useLiveActivityStore.getState().reset();
	globalThis.fetch = originalFetch;
});
test("contributions share authorized source reads, skip unchanged remaps and release removed owners", async () => {
	useLiveActivityStore.getState().upsert({
		id: "foreign",
		appId: "com.ryu.fixture",
		kind: "one",
		status: "running",
		title: "Other producer",
		detail: "Fixture",
		startedAt: 0,
		updatedAt: 0,
	});
	publications = 0;
	await render();
	expect(requests).toHaveLength(1);
	const sourceQueryFn = client
		.getQueryCache()
		.getAll()
		.find((query) => query.queryKey[0] === "contributed-live-activity-source")
		?.options.queryFn;
	await render();
	expect(
		client
			.getQueryCache()
			.getAll()
			.find((query) => query.queryKey[0] === "contributed-live-activity-source")
			?.options.queryFn
	).toBe(sourceQueryFn);
	await tick(() => requests[0].resolve(Response.json(payload)));
	expect(publications).toBe(2);
	const card =
		useLiveActivityStore.getState().activities[
			"plugin:com.ryu.fixture:one:job"
		];
	expect(card).toBeDefined();
	expect(useLiveActivityStore.getState().activities.foreign).toBeDefined();
	contributions = structuredClone(contributions);
	publications = 0;
	await render();
	expect(publications).toBe(0);
	expect(useLiveActivityStore.getState().activities[card.id]).toBe(card);
	await tick(() => {
		void client.invalidateQueries({
			queryKey: ["contributed-live-activity-source"],
		});
	});
	expect(requests).toHaveLength(2);
	expect(publications).toBe(0);
	await tick(() => requests[1].resolve(Response.json(payload)));
	expect(publications).toBe(0);
	expect(useLiveActivityStore.getState().activities[card.id]).toBe(card);
	await tick(() => {
		void client.invalidateQueries({
			queryKey: ["contributed-live-activity-source"],
		});
	});
	contributions = [contributions[1]];
	await render();
	expect(useLiveActivityStore.getState().activities[card.id]).toBeUndefined();
	expect(
		useLiveActivityStore.getState().activities["plugin:com.ryu.fixture:two:job"]
	).toBeDefined();
	expect(requests).toHaveLength(3);
	expect(requests[2].signal?.aborted).toBe(false);
	node = { ...node, userJwt: "next" };
	await render();
	expect(requests).toHaveLength(4);
	expect(requests[2].signal?.aborted).toBe(true);
	expect(
		useLiveActivityStore.getState().activities["plugin:com.ryu.fixture:two:job"]
	).toBeUndefined();
	contributions = [];
	await render();
	expect(requests[3].signal?.aborted).toBe(true);
	expect(useLiveActivityStore.getState().activities.foreign).toBeDefined();
});
