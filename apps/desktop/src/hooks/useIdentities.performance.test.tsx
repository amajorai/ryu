import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 300_000 } },
});
let node = { url: "http://node.test", token: "node", userJwt: "a" };
const reads: {
	jwt: string;
	signal: AbortSignal;
	resolve: <TValue>(value: TValue) => void;
}[] = [];
let finishDelete: () => void;
const mutations: string[] = [];
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/identities.ts", () => ({
	listIdentities: (target: typeof node, signal: AbortSignal) =>
		new Promise((resolve) =>
			reads.push({ jwt: target.userJwt, signal, resolve })
		),
	deleteConnection: (target: typeof node) => {
		mutations.push(target.userJwt);
		return new Promise<void>((resolve) => {
			finishDelete = resolve;
		});
	},
	createConnection: async () => ({}),
	beginLogin: async () => ({}),
	importConnection: async () => undefined,
	pollConnection: async () => ({}),
}));
const { useIdentities } = await import("./useIdentities.ts");
let state: ReturnType<typeof useIdentities>;
let root = createRoot(document.createElement("div"));
function Reader() {
	state = useIdentities();
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
const render = () =>
	act(async () => {
		root.render(<Harness />);
	});
const settle = (index: number, profile: string) =>
	act(async () => {
		reads[index]!.resolve([{ profile_id: profile, connections: [] }]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	root = createRoot(document.createElement("div"));
	reads.length = 0;
	mutations.length = 0;
	node = { url: "http://node.test", token: "node", userJwt: "a" };
});
test("shared identity reads cancel and isolate a changed account on the same node", async () => {
	await render();
	expect(reads).toHaveLength(1);
	node = { ...node, userJwt: "b" };
	await render();
	expect(reads).toHaveLength(2);
	expect(reads[0]!.signal.aborted).toBe(true);
	await settle(0, "Old account");
	expect(state.profileIds).toEqual([]);
	await settle(1, "Current account");
	expect(state.profileIds).toEqual(["Current account"]);
	const ids = state.profileIds;
	await render();
	expect(state.profileIds).toBe(ids);
	expect(reads).toHaveLength(2);
});
test("late mutations invalidate their original account without refreshing the new one", async () => {
	await render();
	await settle(0, "Account A");
	let operation!: Promise<void>;
	await act(async () => {
		operation = state.remove("connection-a");
	});
	node = { ...node, userJwt: "b" };
	await render();
	await settle(1, "Account B");
	expect(state.deleting).toBeNull();
	await act(async () => {
		finishDelete();
		await operation;
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(mutations).toEqual(["a"]);
	expect(reads).toHaveLength(2);
	expect(state.profileIds).toEqual(["Account B"]);
	node = { ...node, userJwt: "a" };
	await render();
	expect(reads).toHaveLength(3);
	expect(reads[2]!.jwt).toBe("a");
});

test("rotating the node token also separates cached identities", async () => {
	await render();
	await settle(0, "Before rotation");
	node = { ...node, token: "rotated-node-token" };
	await render();
	expect(reads).toHaveLength(2);
	expect(state.profileIds).toEqual([]);
	await settle(1, "After rotation");
	expect(state.profileIds).toEqual(["After rotation"]);
});

test("a successful mutation supersedes an initial identity read", async () => {
	await render();
	let operation!: Promise<void>;
	await act(async () => {
		operation = state.remove("connection-a");
	});
	await act(async () => {
		finishDelete();
		await operation;
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(reads[0]!.signal.aborted).toBe(true);
	expect(reads).toHaveLength(2);
	await settle(0, "Stale identities");
	expect(state.profileIds).toEqual([]);
	await settle(1, "Refreshed identities");
	expect(state.profileIds).toEqual(["Refreshed identities"]);
});
