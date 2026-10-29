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
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
let node = {
	token: "node-token",
	url: "http://node.test",
	userJwt: "user-one",
};
const spaces = [
	{ id: "space-one", name: "One" },
	{ id: "space-two", name: "Two" },
];
const documentRevisions = new Map([
	["space-one", 1],
	["space-two", 2],
]);
const reads: Array<{
	resolve: <TValue>(value: TValue) => void;
	signal: AbortSignal | null | undefined;
}> = [];

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/contexts/SpacesContext.tsx", () => ({
	useSpacesContext: () => ({
		documentRevisions,
		error: null,
		loading: false,
		spaces,
	}),
}));
mock.module("@/src/hooks/useSidebarSectionSource.ts", () => ({
	useSidebarSectionSources: () => [],
}));
mock.module("@/src/lib/query-client.ts", () => ({ queryClient: client }));
const clientApi = await import("@/src/lib/api/client.ts");
mock.module("@/src/lib/api/client.ts", () => ({
	...clientApi,
	request: () =>
		Promise.reject(
			new Error("Unexpected unmocked Core request in mention resources fixture")
		),
	toTarget: (value: typeof node) => value,
}));
const toolCatalogReads: unknown[] = [];
const toolSearches: Array<{
	tool: string;
	agentId: string;
	arguments: { query: string };
}> = [];
mock.module("@/src/lib/api/mcp.ts", () => ({
	fetchMcpTools: async (target: unknown, agentId: string) => {
		toolCatalogReads.push({ target, agentId });
		return Array.from({ length: 12 }, (_, index) => ({
			id: `search-${index}`,
			server: `server-${index}`,
			meta: {
				"openai/extensions": { "mentions/search": {} },
				ui: { visibility: ["app"] },
			},
		}));
	},
	callMcpTool: async (
		_target: unknown,
		input: (typeof toolSearches)[number]
	) => {
		toolSearches.push(input);
		return {
			ok: true,
			output: {
				items: [
					{
						type: "resource_link",
						uri: `https://resources.test/${input.tool}`,
						name: input.arguments.query,
					},
				],
			},
		};
	},
}));
mock.module("@/src/lib/api/output-styles.ts", () => ({
	listOutputStyles: async () => ({ styles: [] }),
}));
mock.module("@/src/lib/api/spaces.ts", () => ({
	fetchDocuments: (
		_target: typeof node,
		_spaceId: string,
		signal: AbortSignal
	) =>
		new Promise((resolve) => {
			reads.push({ resolve, signal });
		}),
}));

const { useMentionableResources } = await import(
	"./useMentionableResources.ts"
);
let latest: ReturnType<typeof useMentionableResources>;
let root = createRoot(document.createElement("div"));
let mentionQuery: string | null = null;
let agentId: string | undefined;

function Reader() {
	latest = useMentionableResources([], { agentId, query: mentionQuery });
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
	reads.length = 0;
	toolCatalogReads.length = 0;
	toolSearches.length = 0;
	mentionQuery = null;
	agentId = undefined;
	node = { ...node, userJwt: "user-one" };
});

test("chat mention document observers keep stable descriptors across renders", async () => {
	await act(async () => root.render(<Harness />));
	await flush();
	expect(reads).toHaveLength(2);
	const queryFns = client
		.getQueryCache()
		.getAll()
		.filter((query) => query.queryKey[0] === "space-documents")
		.map((query) => query.options.queryFn);

	await act(async () => root.render(<Harness />));
	await flush();
	expect(reads).toHaveLength(2);
	expect(
		client
			.getQueryCache()
			.getAll()
			.filter((query) => query.queryKey[0] === "space-documents")
			.map((query) => query.options.queryFn)
	).toEqual(queryFns);
	expect(latest.pages).toEqual([]);
	expect(toolCatalogReads).toHaveLength(0);
	expect(toolSearches).toHaveLength(0);
});

test("mention search debounces draft edits, caps server fanout, and reuses cached results on rerender", async () => {
	agentId = "agent-one";
	mentionQuery = "a";
	await act(async () => root.render(<Harness />));
	for (const draft of ["ab", "abc", "final query"]) {
		mentionQuery = draft;
		await act(async () => root.render(<Harness />));
	}
	expect(toolCatalogReads).toHaveLength(0);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 300));
	});
	await flush();
	await flush();
	expect(toolCatalogReads).toEqual([{ target: node, agentId: "agent-one" }]);
	expect(toolSearches).toEqual(
		Array.from({ length: 8 }, (_, index) => ({
			tool: `search-${index}`,
			agentId: "agent-one",
			arguments: { query: "final query" },
		}))
	);
	expect(latest.appItems).toHaveLength(8);
	await act(async () => root.render(<Harness />));
	await flush();
	expect(toolCatalogReads).toHaveLength(1);
	expect(toolSearches).toHaveLength(8);
	expect(reads).toHaveLength(2);
});
