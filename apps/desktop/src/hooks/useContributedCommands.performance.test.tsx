import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);

const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
let node = {
	token: "node-token",
	url: "http://node.test",
	userJwt: "user-one",
};
const section: PluginSidebarSection = {
	approved_grants: ["ui:declarative-http"],
	http_policy: "core",
	id: "records",
	plugin: "com.example.records",
	spec: {
		source: {
			http: { method: "GET", path: "/api/records" },
			items: "items",
			map: { id: "id", title: "title" },
		},
	},
	title: "Records",
};
const contributions = { sidebar_sections: [section] };

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/hooks/usePluginContributions.ts", () => ({
	usePluginContributions: () => contributions,
}));
mock.module("@/src/lib/api/client.ts", () => ({
	apiUrl: (target: typeof node, path: string) => target.url + path,
	requestHeaders: async () => ({}),
	toTarget: (target: typeof node) => target,
}));

const { useContributedSectionItems } = await import(
	"./useContributedCommands.ts"
);

const originalFetch = globalThis.fetch;
const reads: Array<{
	resolve: (response: Response) => void;
	signal: AbortSignal | null | undefined;
}> = [];
let latest: ReturnType<typeof useContributedSectionItems> = [];
let root = createRoot(document.createElement("div"));

function Reader({ enabled }: { enabled: boolean }) {
	latest = useContributedSectionItems(enabled);
	return null;
}

function Harness({ enabled }: { enabled: boolean }) {
	return (
		<QueryClientProvider client={client}>
			<Reader enabled={enabled} />
		</QueryClientProvider>
	);
}

function installFetch() {
	Reflect.set(
		globalThis,
		"fetch",
		mock(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					reads.push({
						resolve,
						signal: init?.signal,
					});
				})
		)
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
	globalThis.fetch = originalFetch;
	reads.length = 0;
	node = { ...node, userJwt: "user-one" };
});

test("closed palette reads nothing and open re-renders keep one query function", async () => {
	installFetch();
	await act(async () => root.render(<Harness enabled={false} />));
	await flush();
	expect(reads).toHaveLength(0);

	await act(async () => root.render(<Harness enabled />));
	await flush();
	expect(reads).toHaveLength(1);
	const query = client
		.getQueryCache()
		.getAll()
		.find((candidate) => candidate.queryKey[0] === "command-section-items");
	const queryFn = query?.options.queryFn;
	expect(queryFn).toBeDefined();

	await act(async () => root.render(<Harness enabled />));
	expect(reads).toHaveLength(1);
	expect(
		client
			.getQueryCache()
			.getAll()
			.find((candidate) => candidate.queryKey[0] === "command-section-items")
			?.options.queryFn
	).toBe(queryFn);

	await act(async () => {
		reads[0].resolve(
			Response.json({ items: [{ id: "one", title: "Shared" }] })
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(latest[0]?.items[0]?.item.title).toBe("Shared");
});

test("credential changes isolate the contributed section cache", async () => {
	installFetch();
	await act(async () => root.render(<Harness enabled />));
	await flush();
	expect(reads).toHaveLength(1);
	node = { ...node, userJwt: "user-two" };
	await act(async () => root.render(<Harness enabled />));
	await flush();
	expect(reads).toHaveLength(2);
	expect(reads[0]?.signal?.aborted).toBe(true);
	await act(async () => {
		reads[1].resolve(
			Response.json({ items: [{ id: "two", title: "Current" }] })
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(latest[0]?.items[0]?.item.title).toBe("Current");
});
