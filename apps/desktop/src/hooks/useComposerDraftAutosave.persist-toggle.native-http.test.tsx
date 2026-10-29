import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The three composer-draft hooks ChatPage calls on every render, over real
// loopback HTTP. ChatPage hands them `persist: !ghostChatActive`, so turning on
// "Temporary chat" flips `persist` on a mounted page. A hook that is skipped on
// some renders changes the page's hook order and crashes it ("Something broke"),
// so these cases mount the hooks the way the page does and flip `persist` under
// them. What a temporary chat must leave behind is pinned beside it: nothing
// saved, nothing restored, nothing queued.
const nativeFetch = globalThis.fetch;
// Bun's native fetch rejects happy-dom's AbortSignal ("signal is not of type
// AbortSignal"), and every query passes one, so the native pair stays in place.
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const NativeResponse = globalThis.Response;
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { useComposerAutoQueue } = await import("./useComposerAutoQueue.ts");
const { draftIdFor, useComposerDraftAutosave, useComposerDraftRestore } =
	await import("./useComposerDraftAutosave.ts");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { LOCAL_FALLBACK, useNodeStore } = await import(
	"@/src/store/useNodeStore.ts"
);

const CONVERSATION_ID = "conv-draft-hooks";
const STORED_TEXT = "Unsent plan for the billing page";
const NEW_TEXT = "Unsent plan for the billing page, second pass";

const requests: string[] = [];
const draftWrites: Record<string, unknown>[] = [];
let draftsAppEnabled = true;
function draftWire(text: string, id: string) {
	return {
		created_at: 1,
		id,
		preview: text,
		source: "composer-autosave",
		state: "draft",
		state_label: "Draft",
		text,
		trigger: { kind: "manual" },
		updated_at: 1,
		waiting_for: "",
	};
}
const server = Bun.serve({
	async fetch(request) {
		const url = new URL(request.url);
		requests.push(`${request.method} ${url.pathname}`);
		if (url.pathname === "/api/plugins/contributions") {
			return NativeResponse.json({
				chat_features: [],
				companions: [],
				composer_controls: [],
				message_actions: [],
				sidebar_buttons: draftsAppEnabled
					? [
							{
								id: "home",
								plugin: "@ryu/drafts",
								target: "/drafts",
								title: "Drafts",
							},
						]
					: [],
			});
		}
		if (url.pathname === "/api/drafts/settings") {
			return NativeResponse.json({
				settings: {
					auto_queue_enabled: true,
					autosave_enabled: true,
					autosave_min_chars: 3,
					max_concurrent: 2,
				},
			});
		}
		if (url.pathname === "/api/runs") {
			return NativeResponse.json({ runs: [] });
		}
		if (url.pathname === "/api/drafts/drafts" && request.method === "POST") {
			const body = (await request.json()) as Record<string, unknown>;
			draftWrites.push(body);
			return NativeResponse.json({
				draft: draftWire(String(body.text), String(body.id)),
			});
		}
		if (url.pathname.startsWith("/api/drafts/drafts/")) {
			const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			return NativeResponse.json({
				draft:
					id === draftIdFor(CONVERSATION_ID)
						? draftWire(STORED_TEXT, id)
						: null,
			});
		}
		return new NativeResponse("unexpected", { status: 404 });
	},
	hostname: "127.0.0.1",
	port: 0,
});
const token = "composer-draft-hooks-token";

let root: Root | null = null;
let host: HTMLElement | null = null;
let autosave: ((draft: string) => void) | null = null;
let autoQueue: ((text: string) => Promise<boolean>) | null = null;
function Probe({ persist }: { persist: boolean }) {
	const context = { conversationId: CONVERSATION_ID, persist };
	autosave = useComposerDraftAutosave(context);
	autoQueue = useComposerAutoQueue(context);
	const restored = useComposerDraftRestore(context);
	return <span data-restored={restored ?? ""} />;
}
const restoredText = () =>
	host?.querySelector("[data-restored]")?.getAttribute("data-restored") ?? null;

async function render(persist: boolean) {
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient}>
				<Probe persist={persist} />
			</QueryClientProvider>
		);
	});
}
async function unmount() {
	await act(async () => root?.render(null));
}
// Lets the contributions read, the draft restore and any flush settle.
async function settle() {
	for (let step = 0; step < 20; step += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
const draftsTraffic = () =>
	requests.filter(
		(entry) =>
			entry.includes("/api/drafts/") ||
			entry === "GET /api/runs" ||
			entry.startsWith("POST /api/drafts")
	);

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	requests.length = 0;
	draftWrites.length = 0;
	draftsAppEnabled = true;
	autosave = null;
	autoQueue = null;
	queryClient.clear();
	useNodeStore.setState({
		defaultNode: "draft-hooks-node",
		nodes: [
			{
				...LOCAL_FALLBACK,
				name: "draft-hooks-node",
				token,
				url: `http://127.0.0.1:${server.port}`,
			},
		],
		tabOverrides: {},
	});
});
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});
afterAll(async () => {
	server.stop(true);
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

test("a chat that turns temporary, and back, renders through the draft hooks each time", async () => {
	await render(true);
	await settle();
	expect(restoredText()).toBe(STORED_TEXT);
	// "Temporary chat" is turned on: `persist` flips on the mounted page.
	await render(false);
	await settle();
	expect(restoredText()).toBe("");
	// Turned off again, or the chat saved: the kept chat's draft is restored.
	await render(true);
	await settle();
	expect(restoredText()).toBe(STORED_TEXT);
});

test("a temporary chat neither restores, saves nor queues the composer's text", async () => {
	await render(false);
	await settle();
	expect(restoredText()).toBe("");
	autosave?.(NEW_TEXT);
	// Closing the tab flushes anything the autosave was still holding back.
	await unmount();
	await settle();
	expect(draftWrites).toEqual([]);
	expect(await autoQueue?.("send this now")).toBe(false);
	expect(draftsTraffic()).toEqual([]);
});

test("a kept chat restores its draft, saves the composer's text and reads the running count before it sends", async () => {
	await render(true);
	await settle();
	expect(restoredText()).toBe(STORED_TEXT);
	autosave?.(NEW_TEXT);
	await unmount();
	await settle();
	expect(draftWrites).toHaveLength(1);
	expect(draftWrites[0]).toMatchObject({
		conversation_id: CONVERSATION_ID,
		id: draftIdFor(CONVERSATION_ID),
		source: "composer-autosave",
		text: NEW_TEXT,
	});
	requests.length = 0;
	expect(await autoQueue?.("send this now")).toBe(false);
	expect(requests).toContain("GET /api/runs");
});

test("without the Drafts app a kept chat restores, saves and queues nothing", async () => {
	draftsAppEnabled = false;
	await render(true);
	await settle();
	expect(restoredText()).toBe("");
	autosave?.(NEW_TEXT);
	await unmount();
	await settle();
	expect(draftWrites).toEqual([]);
	expect(await autoQueue?.("send this now")).toBe(false);
	expect(draftsTraffic()).toEqual([]);
});
