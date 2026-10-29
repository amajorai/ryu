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
type History = ReturnType<typeof useChatHistoryContext>;
type Operation = "edit" | "regenerate" | "select";
let credentialMode: "jwt" | "token" = "jwt";
let httpStatus = 200;
let current: History,
	retained: History | undefined,
	operation: Operation = "edit",
	holding = false,
	release: (() => void) | undefined;
const outputs: unknown[] = [],
	unexpected: string[] = [],
	calls: {
		slot: "A" | "B";
		method: string;
		path: string;
		body: unknown;
		jwt: string | null;
		auth: string | null;
	}[] = [];
const PATHS = {
	edit: "/api/conversations/shared-%2Fid/messages/source-%2Fmessage/edit",
	regenerate:
		"/api/conversations/shared-%2Fid/messages/source-%2Fmessage/regenerate",
	select: "/api/conversations/shared-%2Fid/messages/version-%2Fid/select",
};
const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request: Request): Promise<Response> => {
		const url = new URL(request.url),
			path = url.pathname;
		const auth = request.headers.get("authorization"),
			jwt = request.headers.get("x-ryu-user-jwt");
		const slot =
			credentialMode === "jwt"
				? auth === "Bearer continuation-token" && jwt === "continuation-jwt-A"
					? "A"
					: auth === "Bearer continuation-token" && jwt === "continuation-jwt-B"
						? "B"
						: undefined
				: auth === "Bearer continuation-token-A" && jwt === "continuation-jwt"
					? "A"
					: auth === "Bearer continuation-token-B" && jwt === "continuation-jwt"
						? "B"
						: undefined;
		const route = path.replace(/^\/shared/, "");
		if (
			!slot ||
			!(
				(request.method === "GET" &&
					["/api/conversations", "/api/conversations/shared-%2Fid"].includes(
						route
					)) ||
				(request.method === "POST" && Object.values(PATHS).includes(route))
			)
		) {
			unexpected.push(request.method + " " + path);
			return NativeResponse.json(
				{ error: "Unsupported route or credentials" },
				{ status: 403 }
			);
		}
		const body = request.body ? await request.json() : null;
		calls.push({ slot, method: request.method, path: route, body, jwt, auth });
		if (request.method === "GET" && route === "/api/conversations")
			return NativeResponse.json({
				conversations: [
					{
						id: "shared-/id",
						title: slot === "A" ? "A persisted" : "New Chat",
						folder_path: "/" + slot,
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
		const responseStatus = httpStatus;
		if (holding)
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		if (responseStatus !== 200)
			return NativeResponse.json(
				{ error: "Continuation refused" },
				{ status: responseStatus }
			);
		if (request.method === "GET")
			return NativeResponse.json({
				has_older_messages: false,
				messages: [
					{
						id: slot + "-message",
						role: "user",
						content: slot + " history content",
						created_at: 3,
					},
				],
			});
		return NativeResponse.json(
			route === PATHS.edit
				? { message_id: slot + "-edited-message" }
				: { ok: true }
		);
	},
});
function select(slot: "A" | "B") {
	useNodeStore.setState({
		defaultNode: slot,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
		nodes: ["A", "B"].map((name) => ({
			name,
			url: server.url.origin + "/shared",
			token:
				credentialMode === "jwt"
					? "continuation-token"
					: "continuation-token-" + name,
			userJwt:
				credentialMode === "jwt"
					? "continuation-jwt-" + name
					: "continuation-jwt",
		})),
	});
}
function invoke(history: History) {
	return operation === "edit"
		? history.editMessage("shared-/id", "source-/message", "New B content")
		: operation === "regenerate"
			? history.regenerateMessage("shared-/id", "source-/message")
			: history.selectVersion("shared-/id", "version-/id");
}
function Consumer() {
	current = useChatHistoryContext();
	return (
		<>
			<output>
				{JSON.stringify(
					current.conversations.map((c) => ({
						title: c.title,
						folder: c.folderPath,
					}))
				)}
			</output>
			<output data-testid="loading">
				{String(current.conversationsLoading)}
			</output>
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
async function until(check: () => boolean) {
	for (let i = 0; i < 250; i++) {
		if (check()) return;
		await act(async () => {
			await new Promise((r) => setTimeout(r, 4));
		});
	}
	expect(check()).toBe(true);
}
function rows() {
	return JSON.parse(container.querySelector("output")!.textContent!);
}
async function switchToB() {
	await act(async () => select("B"));
	await until(
		() =>
			rows()[0]?.folder === "/B" &&
			container.querySelector("[data-testid=loading]")?.textContent === "false"
	);
}
beforeEach(() => {
	credentialMode = "jwt";
	httpStatus = 200;
	calls.length = 0;
	unexpected.length = 0;
	outputs.length = 0;
	retained = undefined;
	holding = false;
	release = undefined;
	operation = "edit";
	localStorage.clear();
	select("A");
});
afterEach(async () => {
	holding = false;
	release?.();
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	useNodeStore.setState(initialStore, true);
	expect(unexpected).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});
test("current B local folder callback updates B after authority generation changes", async () => {
	await mount();
	await until(() => rows()[0]?.folder === "/A");
	await switchToB();
	await act(async () =>
		current.setConversationFolder("shared-/id", "/B/user-selected")
	);
	expect(rows()).toEqual([{ title: "New Chat", folder: "/B/user-selected" }]);
	expect(calls.filter((c) => c.method === "POST")).toEqual([]);
});
test("current B first-message callback seeds B title after authority generation changes", async () => {
	await mount();
	await until(() => rows()[0]?.folder === "/A");
	await switchToB();
	await act(async () =>
		current.seedTitleFromFirstMessage(
			"shared-/id",
			"  Seed B title\nsecond line"
		)
	);
	expect(rows()).toEqual([{ title: "Seed B title", folder: "/B" }]);
	expect(calls.filter((c) => c.method === "POST")).toEqual([]);
});
test("retained A prefetch cannot populate current B newest-page cache at the same URL", async () => {
	await mount();
	await until(() => rows()[0]?.folder === "/A");
	retained = current;
	await switchToB();
	await act(async () => {
		retained!.prefetchConversation("shared-/id");
		outputs.push(await current.loadMessagesPageResult("shared-/id"));
	});
	expect(outputs[0]).toMatchObject({
		status: "ok",
		messages: [{ id: "B-message", content: "B history content" }],
	});
	expect(
		calls
			.filter((c) => c.path === "/api/conversations/shared-%2Fid")
			.map((c) => ({ slot: c.slot, jwt: c.jwt }))
	).toEqual([{ slot: "B", jwt: "continuation-jwt-B" }]);
});
for (const kind of ["edit", "regenerate", "select"] as const) {
	test(`retained A ${kind} callback refuses before emitting a stale navigation write`, async () => {
		operation = kind;
		await mount();
		await until(() => rows()[0]?.folder === "/A");
		retained = current;
		await switchToB();
		await act(async () => {
			outputs.push(await invoke(retained!));
		});
		expect(outputs).toEqual([kind === "edit" ? null : false]);
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
		expect(rows()).toEqual([{ title: "New Chat", folder: "/B" }]);
	});
	test(`held A ${kind} acknowledgement cannot return navigation success under B`, async () => {
		operation = kind;
		await mount();
		await until(() => rows()[0]?.folder === "/A");
		holding = true;
		let pending: Promise<void>;
		await act(async () => {
			pending = Promise.resolve(invoke(current)).then((result) => {
				outputs.push(result);
			});
		});
		await until(() => Boolean(release));
		await switchToB();
		holding = false;
		release!();
		await act(async () => pending!);
		expect(outputs).toEqual([kind === "edit" ? null : false]);
		expect(rows()).toEqual([{ title: "New Chat", folder: "/B" }]);
		const writes = calls.filter((c) => c.method === "POST");
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			slot: "A",
			path: PATHS[kind],
			auth: "Bearer continuation-token",
			jwt: "continuation-jwt-A",
			body: kind === "edit" ? { content: "New B content" } : null,
		});
	});
}

for (const kind of ["edit", "regenerate", "select"] as const)
	test(`current B ${kind} refusal retries identical actual request and returns valid B success`, async () => {
		operation = kind;
		await mount();
		await until(() => rows()[0]?.folder === "/A");
		await switchToB();
		httpStatus = 503;
		await act(async () => {
			outputs.push(await invoke(current));
		});
		expect(outputs).toEqual([kind === "edit" ? null : false]);
		httpStatus = 200;
		await act(async () => {
			outputs.push(await invoke(current));
		});
		expect(outputs[1]).toBe(kind === "edit" ? "B-edited-message" : true);
		const writes = calls.filter((c) => c.method === "POST");
		expect(writes).toHaveLength(2);
		expect(writes[0]).toEqual(writes[1]);
		expect(writes[1]).toMatchObject({
			slot: "B",
			path: PATHS[kind],
			auth: "Bearer continuation-token",
			jwt: "continuation-jwt-B",
			body: kind === "edit" ? { content: "New B content" } : null,
		});
	});
for (const mode of ["token", "jwt", "aba"] as const)
	test(`held newest-page A read is refused after ${mode} authority transition; fresh current read remains valid`, async () => {
		credentialMode = mode === "token" ? "token" : "jwt";
		select("A");
		await mount();
		await until(() => rows()[0]?.folder === "/A");
		holding = true;
		let pending: Promise<void>;
		await act(async () => {
			pending = current.loadMessagesPageResult("shared-/id").then((result) => {
				outputs.push(result);
			});
		});
		await until(() => Boolean(release));
		await switchToB();
		if (mode === "aba") {
			await act(async () => select("A"));
			await until(
				() =>
					rows()[0]?.folder === "/A" &&
					container.querySelector("[data-testid=loading]")?.textContent ===
						"false"
			);
		}
		holding = false;
		release!();
		await act(async () => pending!);
		expect(outputs[0]).toMatchObject({ status: "error", messages: [] });
		await act(async () => {
			outputs.push(await current.loadMessagesPageResult("shared-/id"));
		});
		const slot = mode === "aba" ? "A" : "B";
		expect(outputs[1]).toMatchObject({
			status: "ok",
			messages: [{ id: slot + "-message", content: slot + " history content" }],
		});
		const reads = calls.filter(
			(c) => c.path === "/api/conversations/shared-%2Fid"
		);
		expect(reads.map((c) => c.slot)).toEqual(["A", slot]);
		expect(reads[0]?.jwt).toBe(
			mode === "token" ? "continuation-jwt" : "continuation-jwt-A"
		);
		expect(reads[0]?.auth).toBe(
			mode === "token"
				? "Bearer continuation-token-A"
				: "Bearer continuation-token"
		);
	});
