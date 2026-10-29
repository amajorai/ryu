import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { notifyManager, QueryClient } from "@tanstack/react-query";
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
let node = { url: "http://node.test", token: "token", userJwt: "one" };
const reads: {
	jwt: string | null;
	signal: AbortSignal;
	resolve: (response: Response) => void;
}[] = [];
mock.module("@/src/lib/query-client.ts", () => ({ queryClient: client }));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/client.ts", () => ({
	apiUrl: (target: typeof node, path: string) => target.url + path,
	toTarget: (target: typeof node) => target,
	requestHeaders: async (target: typeof node) => ({
		"x-identity": target.userJwt,
	}),
}));
const originalFetch = globalThis.fetch;
const { useSidebarSectionSources } = await import(
	"./useSidebarSectionSource.ts"
);
const section: PluginSidebarSection = {
	id: "records",
	plugin: "com.example.records",
	title: "Records",
	http_policy: "core",
	approved_grants: ["ui:declarative-http"],
	spec: {
		source: {
			http: { method: "GET", path: "/api/records" },
			items: "items",
			map: { id: "id", title: "title" },
		},
	},
};
const sections = [section];
let first: ReturnType<typeof useSidebarSectionSources>;
let second: ReturnType<typeof useSidebarSectionSources>;
let root = createRoot(document.createElement("div"));
function Reader({ slot }: { slot: number }) {
	const result = useSidebarSectionSources(sections);
	if (slot === 0) {
		first = result;
	} else {
		second = result;
	}
	return null;
}
function Harness({ count = 2 }: { count?: number }) {
	return (
		<>
			{[0, 1].slice(0, count).map((slot) => (
				<Reader key={slot} slot={slot} />
			))}
		</>
	);
}
function installFetch() {
	Reflect.set(
		globalThis,
		"fetch",
		mock(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					if (!init?.signal) {
						throw new Error(
							"Sidebar source fetch requires its query AbortSignal"
						);
					}
					reads.push({
						jwt: new Headers(init?.headers).get("x-identity"),
						signal: init.signal,
						resolve,
					});
				})
		)
	);
}
const settle = (index: number, title: string) =>
	act(async () => {
		reads[index].resolve(Response.json({ items: [{ id: "record", title }] }));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	root = createRoot(document.createElement("div"));
	globalThis.fetch = originalFetch;
	reads.length = 0;
	node = { ...node, userJwt: "one" };
});
test("multiple app section readers share a request and retain it while one remains", async () => {
	installFetch();
	await act(async () => root.render(<Harness />));
	expect(reads).toHaveLength(1);
	const queryFn = client
		.getQueryCache()
		.getAll()
		.find((query) => query.queryKey[0] === "contributed-section-source")
		?.options.queryFn;
	expect(queryFn).toBeDefined();
	await act(async () => root.render(<Harness />));
	expect(
		client
			.getQueryCache()
			.getAll()
			.find((query) => query.queryKey[0] === "contributed-section-source")
			?.options.queryFn
	).toBe(queryFn);
	await act(async () => root.render(<Harness count={1} />));
	expect(reads[0].signal.aborted).toBe(false);
	await settle(0, "Shared row");
	expect(first[0].rows[0].item.title).toBe("Shared row");
	await act(async () => root.render(<Harness />));
	expect(reads).toHaveLength(1);
	expect(second[0].rows[0].item.title).toBe("Shared row");
});
test("identity changes cancel obsolete reads and isolate cached rows", async () => {
	installFetch();
	await act(async () => root.render(<Harness />));
	node = { ...node, userJwt: "two" };
	await act(async () => root.render(<Harness />));
	expect(reads).toHaveLength(2);
	expect(reads[0].signal.aborted).toBe(true);
	expect(reads.map((read) => read.jwt)).toEqual(["one", "two"]);
	await settle(0, "Old identity");
	expect(first[0].rows).toEqual([]);
	await settle(1, "New identity");
	expect(first[0].rows[0].item.title).toBe("New identity");
});

test("denied reads remain errors and an explicit refetch recovers the collection", async () => {
	installFetch();
	await act(async () => root.render(<Harness />));
	await act(async () => {
		reads[0].resolve(Response.json({ error: "Denied" }, { status: 403 }));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(first[0].error?.message).toBe("Collection could not be loaded (403).");
	expect(first[0].rows).toEqual([]);
	expect(reads).toHaveLength(1);
	await act(async () => {
		void client.refetchQueries({ queryKey: ["contributed-section-source"] });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await settle(1, "Recovered row");
	expect(first[0].error).toBeNull();
	expect(first[0].rows[0].item.title).toBe("Recovered row");
});
