import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
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
const calls: {
	slot: Slot;
	method: string;
	body: unknown;
	authorization: string | null;
	jwt: string | null;
}[] = [];
const unexpected: string[] = [];
let saved: Record<Slot, string>;
let removed: Record<Slot, boolean>;
let refuse = false;
let mode: "url" | "token" | "jwt" = "url";
let childMounts = 0;
const results: boolean[] = [];
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
let held: { slot: Slot; method: string } | undefined;
let release: (() => void) | undefined;
const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const match =
			/^\/(A|B)\/api\/conversations(?:\/chat-%2Ffixture\/visibility)?$/.exec(
				url.pathname
			);
		if (!match || (request.method !== "GET" && request.method !== "POST")) {
			unexpected.push(request.method + " " + url.pathname);
			return NativeResponse.json(
				{ error: "Unsupported route" },
				{ status: 503 }
			);
		}
		const auth = request.headers.get("authorization"),
			jwt = request.headers.get("x-ryu-user-jwt");
		const selected = targets().find(
			(t) =>
				new URL(t.url).pathname === `/${match[1]}` &&
				auth === `Bearer ${t.token}` &&
				jwt === t.userJwt
		);
		const slot = selected?.name as Slot;
		if (!selected) {
			unexpected.push("Incorrect authority " + slot);
			return NativeResponse.json(
				{ error: "Refused credentials" },
				{ status: 403 }
			);
		}
		const body = request.method === "POST" ? await request.json() : null;
		calls.push({
			slot,
			method: request.method,
			body,
			authorization: auth,
			jwt,
		});
		const rejected = refuse;
		const pendingRequest = held;
		if (
			pendingRequest &&
			pendingRequest.slot === slot &&
			pendingRequest.method === request.method
		)
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		if (request.method === "POST") {
			if (
				!url.pathname.endsWith("/api/conversations/chat-%2Ffixture/visibility")
			) {
				unexpected.push("Invalid mutation path");
				return NativeResponse.json({}, { status: 503 });
			}
			if (rejected)
				return NativeResponse.json(
					{ error: "visibility denied" },
					{ status: 503 }
				);
			if (
				!body ||
				Object.keys(body).length !== 1 ||
				!["org", "private"].includes(body.visibility)
			) {
				unexpected.push("Invalid policy");
				return NativeResponse.json({}, { status: 400 });
			}
			saved[slot] = body.visibility;
			return NativeResponse.json({ ok: true });
		}
		return NativeResponse.json({
			conversations: removed[slot]
				? []
				: [
						{
							id: slot === "A" ? "chat-/fixture" : "chat-B",
							title: `${slot} conversation`,
							agent_id: null,
							archived: false,
							branch: null,
							created_at: 1,
							updated_at: 2,
							folder_path: null,
							worktree_path: null,
							message_count: 2,
							run_status: null,
							visibility: saved[slot],
						},
					],
		});
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
	const history = useChatHistoryContext();
	const [draft, setDraft] = useState("");
	useEffect(() => {
		childMounts++;
	}, []);
	return (
		<>
			<output data-testid="rows">
				{JSON.stringify(
					history.conversations.map((c) => ({
						title: c.title,
						visibility: c.visibility,
					}))
				)}
			</output>
			<button
				onClick={() => {
					void history
						.setConversationVisibility("chat-/fixture", "org")
						.then((r) => results.push(r));
				}}
			>
				Share
			</button>
			<button onClick={() => history.refresh()}>Refresh</button>
			<output data-testid="loading">
				{String(history.conversationsLoading)}
			</output>
			<input
				aria-label="Unrelated draft"
				value={draft}
				onInput={(e) => setDraft(e.currentTarget.value)}
			/>
			<button
				onClick={() =>
					history.createConversation("local-draft", {
						title: "Unsent local draft",
					})
				}
			>
				Draft
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
async function share() {
	await act(async () => {
		container.querySelector("button")!.click();
	});
}
beforeEach(() => {
	mode = "url";
	childMounts = 0;
	results.length = 0;
	saved = { A: "private", B: "private" };
	removed = { A: false, B: false };
	calls.length = 0;
	unexpected.length = 0;
	refuse = false;
	held = undefined;
	release = undefined;
	localStorage.clear();
	select("A");
});
afterEach(async () => {
	held = undefined;
	release?.();
	await unmount();
	useNodeStore.setState(initialStore, true);
	expect(unexpected).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});
test("real history visibility POST persists exact policy and fresh mount reads it", async () => {
	await mount();
	await until(() => rows()[0]?.title === "A conversation");
	await share();
	await until(() => saved.A === "org");
	expect(calls.filter((c) => c.method === "POST")).toEqual([
		{
			slot: "A",
			method: "POST",
			body: { visibility: "org" },
			authorization: "Bearer token-A",
			jwt: "jwt-A",
		},
	]);
	await unmount();
	await mount();
	await until(() => rows()[0]?.visibility === "org");
	expect(saved.B).toBe("private");
});
test("real refusal restores server policy and identical retry persists, then survives remount", async () => {
	await mount();
	await until(() => rows()[0]?.title === "A conversation");
	refuse = true;
	await share();
	await until(
		() =>
			calls.filter((c) => c.method === "GET").length >= 2 &&
			rows()[0]?.visibility === "private"
	);
	expect(saved.A).toBe("private");
	refuse = false;
	await share();
	await until(() => saved.A === "org");
	expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
		{ visibility: "org" },
		{ visibility: "org" },
	]);
	await unmount();
	await mount();
	await until(() => rows()[0]?.visibility === "org");
	expect(saved.B).toBe("private");
});
test("held A list cannot remain as B conversation after switching authority", async () => {
	held = { slot: "A", method: "GET" };
	await mount();
	await until(() => Boolean(release));
	await act(async () => select("B"));
	held = undefined;
	release!();
	await until(
		() =>
			calls.some((c) => c.slot === "B" && c.method === "GET") &&
			rows().some((r: { title: string }) => r.title === "B conversation")
	);
	expect(rows()).toEqual([{ title: "B conversation", visibility: "private" }]);
	expect(calls.filter((c) => c.method === "POST")).toEqual([]);
});

for (const authorityMode of ["token", "jwt"] as const) {
	test(`held list is refused after same-URL ${authorityMode} rotation`, async () => {
		mode = authorityMode;
		select("A");
		held = { slot: "A", method: "GET" };
		await mount();
		await until(() => Boolean(release));
		await act(async () => select("B"));
		held = undefined;
		release!();
		await until(
			() =>
				calls.some((c) => c.slot === "B") &&
				rows().some((r: { title: string }) => r.title === "B conversation")
		);
		expect(rows()).toEqual([
			{ title: "B conversation", visibility: "private" },
		]);
		expect(calls.filter((c) => c.slot === "B")[0]?.authorization).toBe(
			authorityMode === "jwt" ? "Bearer token-A" : "Bearer token-B"
		);
		expect(calls.filter((c) => c.slot === "B")[0]?.jwt).toBe(
			authorityMode === "token" ? "jwt-A" : "jwt-B"
		);
	});
}
for (const status of [200, 503]) {
	test(`held old visibility ${status} cannot refresh or succeed for B`, async () => {
		await mount();
		await until(() => rows()[0]?.title === "A conversation");
		held = { slot: "A", method: "POST" };
		refuse = status === 503;
		await share();
		await until(() => Boolean(release));
		await act(async () => select("B"));
		await until(() =>
			rows().some((r: { title: string }) => r.title === "B conversation")
		);
		const bReads = calls.filter(
			(c) => c.slot === "B" && c.method === "GET"
		).length;
		held = undefined;
		release!();
		await until(() => results.length === 1);
		expect(results).toEqual([false]);
		expect(saved.A).toBe(status === 200 ? "org" : "private");
		expect(saved.B).toBe("private");
		expect(rows()).toEqual([
			{ title: "B conversation", visibility: "private" },
		]);
		expect(
			calls.filter((c) => c.slot === "B" && c.method === "GET")
		).toHaveLength(bReads);
		expect(calls.filter((c) => c.slot === "B" && c.method === "POST")).toEqual(
			[]
		);
	});
}
test("authority reset preserves unrelated child draft and component lifetime", async () => {
	await mount();
	await until(() => rows()[0]?.title === "A conversation");
	await act(async () => {
		const input = container.querySelector("input")!;
		input.value = "Unsaved unrelated settings";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(container.querySelector("input")!.value).toBe(
		"Unsaved unrelated settings"
	);
	await act(async () => select("B"));
	await until(() =>
		rows().some((r: { title: string }) => r.title === "B conversation")
	);
	expect(container.querySelector("input")!.value).toBe(
		"Unsaved unrelated settings"
	);
	expect(childMounts).toBe(1);
	expect(rows()).toEqual([{ title: "B conversation", visibility: "private" }]);
});
test("same-authority refresh and equivalent target preserve actual unsent local draft", async () => {
	await mount();
	await until(() => rows()[0]?.title === "A conversation");
	await act(async () => container.querySelectorAll("button")[2]!.click());
	await until(() =>
		rows().some((r: { title: string }) => r.title === "Unsent local draft")
	);
	await act(async () => select("A"));
	await until(() => calls.filter((c) => c.method === "GET").length >= 2);
	expect(rows().map((r: { title: string }) => r.title)).toEqual([
		"Unsent local draft",
		"A conversation",
	]);
	expect(childMounts).toBe(1);
});

test("new authority loads while old node read remains held", async () => {
	held = { slot: "A", method: "GET" };
	await mount();
	await until(() => Boolean(release));
	await act(async () => select("B"));
	await until(
		() =>
			calls.some((c) => c.slot === "B" && c.method === "GET") &&
			rows()[0]?.title === "B conversation"
	);
	expect(rows()).toEqual([{ title: "B conversation", visibility: "private" }]);
	held = undefined;
	release!();
});

test("same-authority refresh removes a persisted Core row instead of preserving it as a local draft", async () => {
	await mount();
	await until(() => rows()[0]?.title === "A conversation");
	removed.A = true;
	await act(async () => container.querySelectorAll("button")[1]!.click());
	await until(
		() =>
			calls.filter((c) => c.method === "GET").length >= 2 &&
			container.querySelector("[data-testid=loading]")?.textContent === "false"
	);
	expect(rows()).toEqual([]);
	expect(calls.filter((c) => c.method === "POST")).toEqual([]);
});
