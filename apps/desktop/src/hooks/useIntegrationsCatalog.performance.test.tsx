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

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/integrations.ts", () => ({
	searchIntegrations: () =>
		Promise.resolve({ integrations: [], nextCursor: null }),
}));

const { useIntegrationsCatalog } = await import("./useIntegrationsCatalog.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
let root = createRoot(document.createElement("div"));

function Reader() {
	useIntegrationsCatalog();
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
	root = createRoot(document.createElement("div"));
});

test("Integrations catalog retains its list descriptor across renders", async () => {
	await act(() => root.render(<Harness />));
	const first = client.getQueryCache().getAll()[0]?.options.queryFn;
	expect(first).toBeDefined();

	await act(() => root.render(<Harness />));
	const second = client.getQueryCache().getAll()[0]?.options.queryFn;
	expect(second).toBe(first);
});
