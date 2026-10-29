// `useNodeConversations`: a read-only list for another computer. Rows map
// through the provider's own `summaryToConversation`, archived rows are
// dropped, nothing is fetched while the computer is offline or its group is
// collapsed, last-known rows survive going offline, and a rotating delegation
// neither changes the cache key nor is read stale.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// react-query hands the query an AbortSignal; the native fetch only accepts one
// from the native AbortController, not happy-dom's.
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const {
	fetchNodeConversations,
	nodeConversationsQueryKey,
	useNodeConversations,
} = await import("./useNodeConversations.ts");

const initialStore = useNodeStore.getState();
const hits: { path: string; search: string; jwt: string | null }[] = [];
const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request: Request): Response => {
		const url = new URL(request.url);
		hits.push({
			path: url.pathname,
			search: url.search,
			jwt: request.headers.get("x-ryu-user-jwt"),
		});
		return NativeResponse.json({
			conversations: [
				{
					id: "live",
					title: "Live thread",
					folder_path: "C:\\work\\api",
					created_at: 1,
					updated_at: 5,
					message_count: 3,
					agent_id: null,
					branch: "main",
					worktree_path: null,
					run_status: "running",
					thread_role: "session",
				},
				{
					id: "old",
					title: "Archived thread",
					folder_path: null,
					created_at: 1,
					updated_at: 2,
					message_count: 1,
					agent_id: null,
					branch: null,
					worktree_path: null,
					run_status: null,
					archived: true,
				},
			],
		});
	},
});
const studio = (userJwt: string) => ({
	name: "studio",
	url: `${server.url.origin}/studio`,
	token: "studio-token",
	userJwt,
});

let root: Root | undefined;
let client: QueryClient;
let latest: ReturnType<typeof useNodeConversations> | undefined;
function Probe(props: { online: boolean | null; expanded: boolean }) {
	const node = useNodeStore((s) => s.nodes.find((n) => n.name === "studio"));
	latest = useNodeConversations(node ?? studio("none"), props);
	return null;
}
async function render(props: { online: boolean | null; expanded: boolean }) {
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<Probe {...props} />
			</QueryClientProvider>
		)
	);
}
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
async function until(check: () => boolean) {
	for (let i = 0; i < 400; i++) {
		if (check()) {
			return;
		}
		await settle();
	}
	if (!check()) {
		throw new Error("Timed out waiting for the condition");
	}
}

beforeEach(() => {
	hits.length = 0;
	latest = undefined;
	client = new QueryClient();
	useNodeStore.setState({ nodes: [studio("jwt-1")] });
	root = createRoot(document.createElement("div"));
});
afterEach(async () => {
	await act(async () => root?.unmount());
	client.clear();
	useNodeStore.setState(initialStore, true);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("rows map through summaryToConversation and archived rows are dropped", async () => {
	const rows = await fetchNodeConversations("studio");
	expect(rows.map((row) => row.id)).toEqual(["live"]);
	expect(rows[0]).toMatchObject({
		title: "Live thread",
		folderPath: "C:\\work\\api",
		branch: "main",
		runStatus: "running",
		messageCount: 3,
		updatedAt: 5,
		archived: false,
		hierarchy: { role: "session" },
	});
	expect(hits).toEqual([
		{ path: "/studio/api/conversations", search: "", jwt: "jwt-1" },
	]);
});

test("nothing is fetched while offline, unknown or collapsed", async () => {
	await render({ online: false, expanded: true });
	await render({ online: null, expanded: true });
	await render({ online: true, expanded: false });
	await settle();
	expect(hits).toEqual([]);
	expect(latest?.conversations).toBeUndefined();
});

test("last-known rows are kept after the computer goes offline", async () => {
	await render({ online: true, expanded: true });
	await until(() => latest?.conversations !== undefined);
	expect(latest?.conversations?.map((c) => c.id)).toEqual(["live"]);
	expect(latest?.updatedAt).toBeGreaterThan(0);
	await render({ online: false, expanded: true });
	await settle();
	expect(latest?.conversations?.map((c) => c.id)).toEqual(["live"]);
	expect(hits).toHaveLength(1);
});

test("a rotated delegation keeps the cache key and is used on the next read", async () => {
	expect(nodeConversationsQueryKey(studio("jwt-1"))).toEqual(
		nodeConversationsQueryKey(studio("jwt-2"))
	);
	await render({ online: true, expanded: true });
	await until(() => latest?.conversations !== undefined);
	await act(async () => {
		useNodeStore.setState({ nodes: [studio("jwt-2")] });
	});
	await settle();
	expect(hits).toHaveLength(1);
	expect(latest?.conversations?.map((c) => c.id)).toEqual(["live"]);
	await act(async () => {
		await client.invalidateQueries({
			queryKey: ["node-conversations", "studio"],
		});
	});
	await until(() => hits.length === 2);
	expect(hits.map((hit) => hit.jwt)).toEqual(["jwt-1", "jwt-2"]);
});
