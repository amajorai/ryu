import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
interface Node {
	token: string;
	url: string;
	userJwt: string;
}
const useStore = create<{ node: Node; getActiveNode: () => Node }>(
	(_, get) => ({
		node: { url: "https://a.test", token: "one", userJwt: "caller" },
		getActiveNode: () => get().node,
	})
);
mock.module("@/src/store/useNodeStore.ts", () => ({ useNodeStore: useStore }));
mock.module("@/src/lib/node-compat.ts", () => ({
	isNodeCompatible: () => true,
}));
const reads: Array<{ url: string; signal: AbortSignal }> = [];
mock.module("@/src/lib/api/system.ts", () => ({
	fetchHealth: (node: Node, signal: AbortSignal) => {
		reads.push({ url: node.url, signal });
		return new Promise(() => {});
	},
}));
const { useNodeHealth } = await import("./useNodeHealth.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = createRoot(document.createElement("div"));
function Probe() {
	useNodeHealth();
	return null;
}
afterEach(async () => {
	await act(() => root.unmount());
	client.clear();
});
test("node store changes retarget health without a parent rerender and cancel obsolete probes", async () => {
	await act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>
		)
	);
	expect(reads).toHaveLength(1);
	await act(() =>
		useStore.setState({
			node: { ...useStore.getState().node, url: "https://b.test" },
		})
	);
	expect(reads).toHaveLength(2);
	expect(reads[1].url).toBe("https://b.test");
	expect(reads[0].signal.aborted).toBe(true);
	await act(() =>
		useStore.setState({ node: { ...useStore.getState().node, token: "two" } })
	);
	expect(reads).toHaveLength(3);
	expect(reads[1].signal.aborted).toBe(true);
	await act(() =>
		useStore.setState({
			node: { ...useStore.getState().node, userJwt: "next" },
		})
	);
	expect(reads).toHaveLength(3);
});
