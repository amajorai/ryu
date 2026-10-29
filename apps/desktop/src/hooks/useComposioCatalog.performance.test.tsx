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
let reads = 0;

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/composio.ts", () => ({
	disconnectAgentComposioConnection: async () => undefined,
	fetchAgentComposioConnections: async () => ({}),
	fetchComposioActions: async () => [],
	fetchComposioConnections: async () => [],
	fetchComposioStatus: async () => {
		reads += 1;
		return { configured: true };
	},
	fetchComposioToolkits: async () => [],
	fetchComposioTriggers: async () => [],
	initiateAgentComposioConnection: async () => ({
		connectionId: "agent-connection",
		redirectUrl: "https://example.test/connect",
	}),
	initiateComposioConnection: async () => ({
		connectionId: "connection",
		redirectUrl: "https://example.test/connect",
	}),
}));

const { useComposioStatus } = await import("./useComposioCatalog.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
const root = createRoot(document.createElement("div"));

function Reader() {
	useComposioStatus();
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
	reads = 0;
	node.userJwt = "user-one";
});

test("Composio status keeps its query descriptor across shell renders", async () => {
	await act(() => root.render(<Harness />));
	await act(async () => {
		await Promise.resolve();
	});
	const first = client
		.getQueryCache()
		.getAll()
		.find((query) => query.queryKey[0] === "composio")?.options.queryFn;
	expect(reads).toBe(1);

	await act(() => root.render(<Harness />));
	const second = client
		.getQueryCache()
		.getAll()
		.find((query) => query.queryKey[0] === "composio")?.options.queryFn;
	expect(second).toBe(first);
	expect(reads).toBe(1);

	node.userJwt = "user-two";
	await act(() => root.render(<Harness />));
	await act(async () => {
		await Promise.resolve();
	});
	expect(reads).toBe(2);
	expect(
		client
			.getQueryCache()
			.getAll()
			.map((query) => query.queryKey)
	).toContainEqual([
		"composio",
		"status",
		"http://node.test",
		"node-token",
		"user-two",
	]);
});
