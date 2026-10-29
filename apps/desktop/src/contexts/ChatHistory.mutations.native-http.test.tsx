import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
const nativeFetch = globalThis.fetch,
	NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ChatHistoryProvider, useChatHistoryContext } = await import(
	"@/src/contexts/ChatHistoryContext.tsx"
);
const initialStore = useNodeStore.getState();
type Slot = "A" | "B";
type Action = "rename" | "delete" | "folder" | "retitle";
let mode: "url" | "token" | "jwt" = "url",
	action: Action = "rename",
	status = 200,
	holding = false;
let release: (() => void) | undefined;
let saved: Record<
	Slot,
	{ title: string; folder: string | null; deleted: boolean }
>;
const calls: {
	slot: Slot;
	method: string;
	path: string;
	body: unknown;
	authorization: string | null;
	jwt: string | null;
}[] = [];
const unexpected: string[] = [],
	results: unknown[] = [];
function targets() {
	return [
		{
			name: "A",
			url: server.url.origin + "/A",
			token: "token-A",
			userJwt: "jwt-A",
		},
		{
			name: "B",
			url: server.url.origin + (mode === "url" ? "/B" : "/A"),
			token: mode === "jwt" ? "token-A" : "token-B",
			userJwt: mode === "token" ? "jwt-A" : "jwt-B",
		},
	];
}
const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;
		const auth = request.headers.get("authorization"),
			jwt = request.headers.get("x-ryu-user-jwt");
		const target = targets().find(
			(t) =>
				path.startsWith(new URL(t.url).pathname + "/") &&
				auth === `Bearer ${t.token}` &&
				jwt === t.userJwt
		);
		if (!target) {
			unexpected.push("Bad target: " + request.method + " " + path);
			return NativeResponse.json({}, { status: 403 });
		}
		const slot = target.name as Slot,
			prefix = new URL(target.url).pathname;
		const route = path.slice(prefix.length);
		if (
			!(
				(request.method === "GET" && route === "/api/conversations") ||
				(request.method === "DELETE" &&
					route === "/api/conversations/shared-%2Fid") ||
				(request.method === "POST" &&
					[
						"/api/conversations/shared-%2Fid/title",
						"/api/conversations/shared-%2Fid/folder",
						"/api/conversations/shared-%2Fid/retitle",
					].includes(route))
			)
		) {
			unexpected.push("Unsupported " + request.method + " " + path);
			return NativeResponse.json({}, { status: 503 });
		}
		const body = request.body ? await request.json() : null;
		calls.push({
			slot,
			method: request.method,
			path: route,
			body,
			authorization: auth,
			jwt,
		});
		if (request.method === "GET")
			return NativeResponse.json({
				conversations: saved[slot].deleted
					? []
					: [
							{
								id: "shared-/id",
								title: saved[slot].title,
								folder_path: saved[slot].folder,
								created_at: 1,
								updated_at: 2,
								message_count: 2,
								agent_id: null,
								branch: null,
								worktree_path: null,
								run_status: null,
							},
						],
			});
		const responseStatus = status;
		if (holding)
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		if (responseStatus !== 200)
			return NativeResponse.json(
				{ error: "Owned mutation refused" },
				{ status: responseStatus }
			);
		if (request.method === "DELETE") saved[slot].deleted = true;
		else if (route.endsWith("/title")) saved[slot].title = body.title;
		else if (route.endsWith("/folder")) saved[slot].folder = body.folder_path;
		else if (route.endsWith("/retitle"))
			saved[slot].title = "Generated A title";
		return NativeResponse.json(
			route.endsWith("/retitle") ? { title: saved[slot].title } : { ok: true }
		);
	},
});
function select(slot: Slot) {
	useNodeStore.setState({
		defaultNode: slot,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
		nodes: targets(),
	});
}
function Consumer() {
	const h = useChatHistoryContext();
	return (
		<>
			<output>
				{JSON.stringify(
					h.conversations.map((c) => ({
						title: c.title,
						folder: c.folderPath ?? null,
					}))
				)}
			</output>
			<output data-testid="loading">{String(h.conversationsLoading)}</output>
			<button
				onClick={() => {
					const pending =
						action === "rename"
							? h.renameConversation("shared-/id", "B original")
							: action === "delete"
								? h.deleteConversation("shared-/id")
								: action === "folder"
									? h.removeConversationFromProject("shared-/id")
									: h.autoRenameConversation("shared-/id");
					void pending.then(
						(value) => results.push(value),
						() => results.push("rejected")
					);
				}}
			>
				Mutate
			</button>
		</>
	);
}
let root: Root | undefined, container: HTMLDivElement;
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<ChatHistoryProvider>
				<Consumer />
			</ChatHistoryProvider>
		)
	);
}
async function unmount() {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
}
function rows() {
	return JSON.parse(container.querySelector("output")!.textContent!);
}
async function until(check: () => boolean) {
	for (let i = 0; i < 250; i++) {
		if (check()) return;
		await act(async () => {
			await new Promise((r) => setTimeout(r, 4));
		});
	}
	expect(check()).toBe(true);
}
async function mutate() {
	await act(async () => container.querySelector("button")!.click());
}
beforeEach(() => {
	mode = "url";
	action = "rename";
	status = 200;
	holding = false;
	release = undefined;
	results.length = 0;
	calls.length = 0;
	unexpected.length = 0;
	saved = {
		A: { title: "A original", folder: "/A", deleted: false },
		B: { title: "B original", folder: "/B", deleted: false },
	};
	localStorage.clear();
	select("A");
});
afterEach(async () => {
	holding = false;
	release?.();
	await unmount();
	useNodeStore.setState(initialStore, true);
	expect(unexpected).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});
for (const mutation of ["rename", "delete", "folder", "retitle"] as const) {
	for (const responseStatus of [200, 503])
		test(`held A ${mutation} ${responseStatus} cannot mutate same-ID B row`, async () => {
			action = mutation;
			status = responseStatus;
			await mount();
			await until(() => rows()[0]?.title === "A original");
			holding = true;
			await mutate();
			await until(() => Boolean(release));
			await act(async () => select("B"));
			await until(
				() =>
					calls.some((c) => c.slot === "B" && c.method === "GET") &&
					rows()[0]?.title === "B original" &&
					rows()[0]?.folder === "/B"
			);
			holding = false;
			release!();
			await until(() => results.length === 1);
			expect(rows()).toEqual([{ title: "B original", folder: "/B" }]);
			expect(saved.B).toEqual({
				title: "B original",
				folder: "/B",
				deleted: false,
			});
			expect(calls.filter((c) => c.slot === "B" && c.method !== "GET")).toEqual(
				[]
			);
			const write = calls.find((c) => c.method !== "GET")!;
			expect(write.authorization).toBe("Bearer token-A");
			expect(write.jwt).toBe("jwt-A");
			expect(write.body).toEqual(
				mutation === "rename"
					? { title: "B original" }
					: mutation === "folder"
						? { folder_path: null }
						: null
			);
			expect(results).toEqual([mutation === "retitle" ? "rejected" : false]);
		});
}
for (const authorityMode of ["token", "jwt"] as const)
	for (const mutation of ["rename", "delete"] as const)
		test(`old ${mutation} refusal is scoped across same-URL ${authorityMode}`, async () => {
			mode = authorityMode;
			action = mutation;
			status = 503;
			select("A");
			await mount();
			await until(() => rows()[0]?.title === "A original");
			holding = true;
			await mutate();
			await until(() => Boolean(release));
			await act(async () => select("B"));
			await until(
				() =>
					calls.some((c) => c.slot === "B" && c.method === "GET") &&
					rows()[0]?.title === "B original" &&
					rows()[0]?.folder === "/B"
			);
			holding = false;
			release!();
			await until(() => results.length === 1);
			expect(rows()).toEqual([{ title: "B original", folder: "/B" }]);
			expect(saved.B).toEqual({
				title: "B original",
				folder: "/B",
				deleted: false,
			});
			expect(calls.filter((c) => c.slot === "B" && c.method !== "GET")).toEqual(
				[]
			);
		});
for (const mutation of ["rename", "delete", "folder", "retitle"] as const)
	test(`same-authority ${mutation} refusal can retry and fresh mount reads saved policy`, async () => {
		action = mutation;
		status = 503;
		await mount();
		await until(() => rows()[0]?.title === "A original");
		await mutate();
		await until(() => results.length === 1);
		expect(saved.A).toEqual({
			title: "A original",
			folder: "/A",
			deleted: false,
		});
		status = 200;
		await mutate();
		await until(() => results.length === 2);
		expect(results[1]).toBe(
			mutation === "retitle" ? "Generated A title" : true
		);
		const writes = calls.filter((c) => c.method !== "GET");
		expect(writes).toHaveLength(2);
		expect(writes[0]).toEqual(writes[1]);
		await unmount();
		await mount();
		await until(
			() =>
				calls.filter((c) => c.method === "GET").length >= 2 &&
				container.querySelector("[data-testid=loading]")?.textContent ===
					"false"
		);
		await until(() =>
			mutation === "delete"
				? rows().length === 0
				: rows()[0]?.title ===
					(mutation === "rename"
						? "B original"
						: mutation === "retitle"
							? "Generated A title"
							: "A original")
		);
		expect(rows()).toEqual(
			mutation === "delete"
				? []
				: [{ title: saved.A.title, folder: saved.A.folder }]
		);
		expect(saved.B).toEqual({
			title: "B original",
			folder: "/B",
			deleted: false,
		});
	});
