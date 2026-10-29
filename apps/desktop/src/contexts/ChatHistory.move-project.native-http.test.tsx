import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ChatHistoryProvider, useChatHistoryContext } = await import(
	"@/src/contexts/ChatHistoryContext.tsx"
);

const initialStore = useNodeStore.getState();

interface Row {
	folder: string | null;
	id: string;
	projectId: string | null;
	role: "main" | "session";
}

let rows: Row[] = [];
const writes: { body: unknown; method: string; path: string }[] = [];
const results: boolean[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request: Request): Promise<Response> => {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/api/conversations") {
			return NativeResponse.json({
				conversations: rows.map((row) => ({
					agent_id: null,
					branch: null,
					created_at: 1,
					folder_path: row.folder,
					id: row.id,
					message_count: 1,
					project_id: row.projectId,
					run_status: null,
					thread_role: row.role,
					title: row.id,
					updated_at: 2,
					worktree_path: null,
				})),
			});
		}
		const body = request.body ? await request.json() : null;
		writes.push({ body, method: request.method, path });
		const folderMatch = path.match(/^\/api\/conversations\/([^/]+)\/folder$/);
		if (request.method === "POST" && folderMatch) {
			const row = rows.find((r) => r.id === folderMatch[1]);
			if (row) {
				row.folder = (body as { folder_path: string | null }).folder_path;
			}
			return NativeResponse.json({ ok: true });
		}
		const projectMatch = path.match(
			/^\/api\/hierarchy\/threads\/([^/]+)\/project$/
		);
		if (request.method === "PUT" && projectMatch) {
			const row = rows.find((r) => r.id === projectMatch[1]);
			if (row) {
				row.projectId = (body as { project_id: string | null }).project_id;
			}
			return NativeResponse.json({ ok: true });
		}
		return NativeResponse.json({}, { status: 404 });
	},
});

let pendingAction: (
	history: ReturnType<typeof useChatHistoryContext>
) => Promise<boolean>;

function Consumer() {
	const history = useChatHistoryContext();
	return (
		<>
			<output>
				{JSON.stringify(
					history.conversations.map((c) => ({
						folder: c.folderPath ?? null,
						id: c.id,
						projectId: c.hierarchy?.projectId ?? null,
					}))
				)}
			</output>
			<button
				onClick={() => {
					void pendingAction(history).then((value) => results.push(value));
				}}
				type="button"
			>
				Act
			</button>
		</>
	);
}

let root: Root | undefined;
let container: HTMLDivElement;

async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<ChatHistoryProvider>
				<Consumer />
			</ChatHistoryProvider>
		)
	);
}

function rendered(): {
	folder: string | null;
	id: string;
	projectId: string | null;
}[] {
	return JSON.parse(container.querySelector("output")?.textContent ?? "[]");
}

async function until(check: () => boolean) {
	for (let i = 0; i < 250; i++) {
		if (check()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 4));
		});
	}
	if (!check()) {
		throw new Error("Timed out waiting for the chat history to settle");
	}
}

async function run(
	action: (
		history: ReturnType<typeof useChatHistoryContext>
	) => Promise<boolean>
) {
	pendingAction = action;
	const before = results.length;
	await act(async () => container.querySelector("button")?.click());
	await until(() => results.length === before + 1);
	return results.at(-1);
}

beforeEach(() => {
	rows = [];
	writes.length = 0;
	results.length = 0;
	localStorage.clear();
	useNodeStore.setState({
		autoSelect: false,
		autoSelectedNode: null,
		defaultNode: "local",
		nodes: [{ name: "local", token: "t", url: server.url.origin }],
		tabOverrides: {},
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	useNodeStore.setState(initialStore, true);
});

afterAll(() => {
	server.stop(true);
});

test("a chat with no project moves into a project by its folder", async () => {
	rows = [{ folder: null, id: "loose", projectId: null, role: "session" }];
	await mount();
	await until(() => rendered().length === 1);

	expect(
		await run((h) => h.moveConversationToProject("loose", "/work/app"))
	).toBe(true);

	expect(writes).toEqual([
		{
			body: { folder_path: "/work/app" },
			method: "POST",
			path: "/api/conversations/loose/folder",
		},
	]);
	expect(rendered()).toEqual([
		{ folder: "/work/app", id: "loose", projectId: null },
	]);
});

test("moving between projects detaches the old node project", async () => {
	rows = [
		{ folder: "/work/old", id: "chat", projectId: "p-old", role: "session" },
	];
	await mount();
	await until(() => rendered()[0]?.projectId === "p-old");

	expect(
		await run((h) => h.moveConversationToProject("chat", "/work/new"))
	).toBe(true);

	expect(writes).toEqual([
		{
			body: { folder_path: "/work/new" },
			method: "POST",
			path: "/api/conversations/chat/folder",
		},
		{
			body: { project_id: null },
			method: "PUT",
			path: "/api/hierarchy/threads/chat/project",
		},
	]);
	expect(rendered()).toEqual([
		{ folder: "/work/new", id: "chat", projectId: null },
	]);
});

test("removing from a project clears both the folder and the node project", async () => {
	rows = [
		{ folder: "/work/old", id: "chat", projectId: "p-old", role: "session" },
	];
	await mount();
	await until(() => rendered()[0]?.projectId === "p-old");

	expect(await run((h) => h.removeConversationFromProject("chat"))).toBe(true);

	expect(writes.map((w) => [w.method, w.path, w.body])).toEqual([
		["POST", "/api/conversations/chat/folder", { folder_path: null }],
		["PUT", "/api/hierarchy/threads/chat/project", { project_id: null }],
	]);
	expect(rendered()).toEqual([{ folder: null, id: "chat", projectId: null }]);
});

test("a project's main thread never moves", async () => {
	rows = [
		{ folder: "/work/old", id: "main", projectId: "p-old", role: "main" },
	];
	await mount();
	await until(() => rendered().length === 1);

	expect(
		await run((h) => h.moveConversationToProject("main", "/work/new"))
	).toBe(false);

	expect(writes).toEqual([]);
	expect(rendered()).toEqual([
		{ folder: "/work/old", id: "main", projectId: "p-old" },
	]);
});
