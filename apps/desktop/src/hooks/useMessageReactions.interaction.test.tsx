import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
const nativeFetch = globalThis.fetch;
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useCurrentTabId: () => undefined,
}));
mock.module("@/src/hooks/useNodeDisplayMode.ts", () => ({
	useNodeTabOverride: () => true,
}));
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useMessageReactions } = await import(
	"@/src/hooks/useMessageReactions.ts"
);
const initialStore = useNodeStore.getState();
type Slot = "A" | "token" | "jwt";
type Bucket = {
	message_id: string;
	emoji: string;
	count: number;
	reacted_by_me: boolean;
};
const MESSAGE = "56093e30-7437-4f4c-8509-39c3842376b4";
const ROOM = "reaction-authority-room";
const calls: Array<{
	slot: Slot;
	method: string;
	body: unknown;
	status: number;
	completed: boolean;
}> = [];
const unexpected: string[] = [];
const consumed: Array<{ slot: Slot; method: string }> = [];
let saved: Record<Slot, Bucket[]>;
let held: {
	release: (() => void) | null;
	status: number;
	emoji?: string;
} | null;
const flights = new Set<Promise<Response>>();
const tokens: Record<Slot, { token: string; userJwt: string }> = {
	A: { token: "node-A-token", userJwt: "user-A-jwt" },
	token: { token: "node-B-token", userJwt: "user-A-jwt" },
	jwt: { token: "node-A-token", userJwt: "user-B-jwt" },
};
function identify(request: Request): Slot | undefined {
	return (Object.keys(tokens) as Slot[]).find(
		(slot) =>
			request.headers.get("authorization") === `Bearer ${tokens[slot].token}` &&
			request.headers.get("x-ryu-user-jwt") === tokens[slot].userJwt
	);
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const task = respond(request);
		flights.add(task);
		void task.then(
			() => flights.delete(task),
			() => flights.delete(task)
		);
		return task;
	},
});
async function respond(request: Request): Promise<Response> {
	const path = new URL(request.url).pathname;
	const slot = identify(request);
	const list =
		path === `/api/conversations/${ROOM}/reactions` && request.method === "GET";
	const write =
		path === `/api/conversations/${ROOM}/messages/${MESSAGE}/reactions` &&
		["POST", "DELETE"].includes(request.method);
	if (!slot || !(list || write)) {
		unexpected.push(`${request.method} ${path}`);
		return NativeResponse.json(
			{ error: "Unimplemented reaction request" },
			{ status: 503 }
		);
	}
	const body: unknown = write ? await request.json() : null;
	const call = {
		slot,
		method: request.method,
		body,
		status: 0,
		completed: false,
	};
	calls.push(call);
	if (list) {
		call.status = 200;
		call.completed = true;
		return NativeResponse.json({ reactions: saved[slot] });
	}
	expect(request.headers.get("content-type")).toContain("application/json");
	if (
		!body ||
		typeof body !== "object" ||
		!("emoji" in body) ||
		Object.keys(body).length !== 1 ||
		!["✅", "👍", "🎉"].includes(String(body.emoji))
	)
		throw new Error("Invalid exact reaction body");
	const emoji = String(body.emoji);
	let status = 200;
	if (
		slot === "A" &&
		held &&
		!held.release &&
		(!held.emoji || held.emoji === emoji)
	) {
		const gate = held;
		await new Promise<void>((resolve) => {
			gate.release = resolve;
		});
		status = gate.status;
	}
	call.status = status;
	call.completed = true;
	if (status !== 200)
		return NativeResponse.json({ error: "Reaction write refused" }, { status });
	const bucket = saved[slot].find((row) => row.emoji === emoji);
	if (request.method === "POST" && !bucket)
		saved[slot].push({
			message_id: MESSAGE,
			emoji,
			count: 1,
			reacted_by_me: true,
		});
	else if (request.method === "POST" && bucket && !bucket.reacted_by_me) {
		bucket.count++;
		bucket.reacted_by_me = true;
	}
	if (request.method === "DELETE" && bucket?.reacted_by_me) {
		bucket.count--;
		bucket.reacted_by_me = false;
		if (bucket.count === 0)
			saved[slot] = saved[slot].filter((row) => row !== bucket);
	}
	return NativeResponse.json({ ok: true });
}
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		const request = new NativeRequest(...args);
		const response = await nativeFetch(...args);
		const read = response.text.bind(response);
		response.text = () => {
			const result = read();
			void result.then(
				() => {
					const slot = identify(request);
					if (slot) consumed.push({ slot, method: request.method });
				},
				() => {}
			);
			return result;
		};
		return response;
	},
	{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
);
let root: Root | undefined;
let container: HTMLDivElement;
let queryClient: QueryClient;
function Probe() {
	const { byMessage, toggle, applyRealtimeFrame } = useMessageReactions(ROOM);
	const bucket = byMessage.get(MESSAGE)?.[0];
	return (
		<div>
			<button
				type="button"
				onClick={() =>
					applyRealtimeFrame(
						{
							type: "reaction",
							message_id: MESSAGE,
							emoji: "👍",
							op: "add",
							user_id: "peer",
						},
						"owner"
					)
				}
			>
				Deliver peer frame
			</button>
			<output data-testid="reaction-list">
				{JSON.stringify(byMessage.get(MESSAGE) ?? [])}
			</output>
			<button type="button" onClick={() => toggle(MESSAGE, "👍")}>
				Toggle thumbs
			</button>
			<button type="button" onClick={() => toggle(MESSAGE, "🎉")}>
				Toggle party
			</button>
			<output data-testid="reaction-state">
				{bucket ? JSON.stringify(bucket) : "loading"}
			</output>
			<button type="button" onClick={() => toggle(MESSAGE, "✅")}>
				Toggle reaction
			</button>
		</div>
	);
}
async function render() {
	root ??= createRoot(container);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={queryClient}>
				<Probe />
			</QueryClientProvider>
		)
	);
}
function state() {
	const text = container.querySelector(
		'[data-testid="reaction-state"]'
	)?.textContent;
	return text && text !== "loading" ? JSON.parse(text) : null;
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 150; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		if (predicate()) return;
	}
	throw new Error(
		`Actual reaction state did not settle: ${container.textContent}; calls=${JSON.stringify(calls)}`
	);
}
async function toggle() {
	const button = [...container.querySelectorAll("button")].find(
		(row) => row.textContent === "Toggle reaction"
	);
	if (!button) throw new Error("Reaction toggle missing");
	await act(async () => button.click());
}
function target(slot: Slot) {
	return { name: slot, url: server.url.origin, ...tokens[slot] };
}
async function select(slot: Slot) {
	await act(async () =>
		useNodeStore.setState({ nodes: [target(slot)], defaultNode: slot })
	);
	await render();
}
const expected = (count: number, mine: boolean) => ({
	messageId: MESSAGE,
	emoji: "✅",
	count,
	reactedByMe: mine,
});
beforeEach(() => {
	saved = {
		A: [{ message_id: MESSAGE, emoji: "✅", count: 1, reacted_by_me: false }],
		token: [
			{ message_id: MESSAGE, emoji: "✅", count: 7, reacted_by_me: true },
		],
		jwt: [{ message_id: MESSAGE, emoji: "✅", count: 4, reacted_by_me: false }],
	};
	calls.length = consumed.length = unexpected.length = 0;
	held = null;
	useNodeStore.setState({
		nodes: [target("A")],
		defaultNode: "A",
		tabOverrides: {},
		autoSelect: false,
		autoSelectedNode: null,
	});
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	container = document.createElement("div");
	document.body.append(container);
});
afterEach(async () => {
	if (held) held.release?.();
	held = null;
	await Promise.all([...flights]);
	await act(async () => root?.unmount());
	root = undefined;
	queryClient.clear();
	container.remove();
	useNodeStore.setState(initialStore, true);
	expect(unexpected).toEqual([]);
	expect(flights.size).toBe(0);
});
afterAll(() => {
	server.stop(true);
	mock.restore();
	globalThis.fetch = nativeFetch;
});
test("real reaction POST refusal rolls the optimistic chip back, retry saves identical payload, reload reads it, and DELETE removes only my membership", async () => {
	await render();
	await until(
		() =>
			consumed.some((call) => call.slot === "A" && call.method === "GET") &&
			state() !== null
	);
	expect(state()).toEqual(expected(1, false));
	held = { release: null, status: 503 };
	await toggle();
	await until(() => !!held?.release);
	expect(state()).toEqual(expected(2, true));
	expect(saved.A[0]).toMatchObject({ count: 1, reacted_by_me: false });
	const gate = held;
	held = null;
	await act(async () => gate.release?.());
	await until(
		() =>
			consumed.some((call) => call.method === "POST") &&
			queryClient
				.getMutationCache()
				.getAll()
				.every((mutation) => mutation.state.status !== "pending")
	);
	expect(state()).toEqual(expected(1, false));
	await toggle();
	await until(
		() => consumed.filter((call) => call.method === "POST").length === 2
	);
	expect(saved.A[0]).toMatchObject({ count: 2, reacted_by_me: true });
	expect(
		calls
			.filter((call) => call.method === "POST")
			.map((call) => ({ body: call.body, status: call.status }))
	).toEqual([
		{ body: { emoji: "✅" }, status: 503 },
		{ body: { emoji: "✅" }, status: 200 },
	]);
	const previousReads = consumed.filter((call) => call.method === "GET").length;
	await act(async () => root!.unmount());
	root = undefined;
	queryClient.clear();
	await render();
	await until(
		() =>
			consumed.filter((call) => call.method === "GET").length > previousReads &&
			state() !== null
	);
	expect(state()).toEqual(expected(2, true));
	await toggle();
	await until(() => consumed.some((call) => call.method === "DELETE"));
	expect(state()).toEqual(expected(1, false));
	expect(saved.A[0]).toMatchObject({ count: 1, reacted_by_me: false });
	expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
});
for (const slot of ["token", "jwt"] as const)
	test(`same-URL ${slot} rotation reloads that authority's own reaction membership rather than reusing A's cached buckets`, async () => {
		await render();
		await until(() => state() !== null);
		expect(state()).toEqual(expected(1, false));
		await select(slot);
		await until(
			() =>
				consumed.some((call) => call.slot === slot && call.method === "GET") &&
				state() !== null
		);
		expect(state()).toEqual(
			slot === "token" ? expected(7, true) : expected(4, false)
		);
		expect(calls.map((call) => [call.slot, call.method])).toEqual([
			["A", "GET"],
			[slot, "GET"],
		]);
	});
for (const status of [200, 503])
	test(`held A POST ${status} cannot replace current same-URL JWT B reaction state or roll A's snapshot into B's cache`, async () => {
		await render();
		await until(() => state() !== null);
		held = { release: null, status };
		await toggle();
		await until(() => !!held?.release);
		await select("jwt");
		await until(
			() =>
				consumed.some((call) => call.slot === "jwt" && call.method === "GET") &&
				state() !== null
		);
		expect(state()).toEqual(expected(4, false));
		const gate = held;
		held = null;
		await act(async () => gate.release?.());
		await until(
			() =>
				consumed.some((call) => call.slot === "A" && call.method === "POST") &&
				queryClient
					.getMutationCache()
					.getAll()
					.every((mutation) => mutation.state.status !== "pending")
		);
		expect(state()).toEqual(expected(4, false));
		expect(saved.jwt[0]).toMatchObject({ count: 4, reacted_by_me: false });
		expect(
			calls.filter((call) => call.method !== "GET").map((call) => call.slot)
		).toEqual(["A"]);
	});

function allReactions(): Array<{
	messageId: string;
	emoji: string;
	count: number;
	reactedByMe: boolean;
}> {
	const raw = container.querySelector(
		'[data-testid="reaction-list"]'
	)?.textContent;
	if (!raw) throw new Error("Missing mounted hook state");
	return JSON.parse(raw);
}
async function choose(emoji: "👍" | "🎉") {
	const text = emoji === "👍" ? "Toggle thumbs" : "Toggle party";
	const button = [...container.querySelectorAll("button")].find(
		(row) => row.textContent === text
	);
	if (!button) throw new Error("Missing actual toggle");
	await act(async () => button.click());
}
const own = (emoji: string) => ({
	messageId: MESSAGE,
	emoji,
	count: 1,
	reactedByMe: true,
});
async function emptyA() {
	saved.A = [];
	await render();
	await until(() =>
		consumed.some((call) => call.slot === "A" && call.method === "GET")
	);
	expect(allReactions()).toEqual([]);
}
async function finishFailedThumbs() {
	const gate = held;
	if (!gate?.release) throw new Error("Held native thumbs request missing");
	gate.release();
	held = null;
	await until(
		() =>
			calls.some(
				(call) =>
					call.slot === "A" &&
					call.method === "POST" &&
					call.status === 503 &&
					call.completed
			) && consumed.some((call) => call.slot === "A" && call.method === "POST")
	);
	// Wait actual TanStack mutation settlement and its rendered notification.
	await until(() =>
		queryClient
			.getMutationCache()
			.getAll()
			.every((mutation) => mutation.state.status !== "pending")
	);
}
test("overlapping refused Add rolls back only its emoji and preserves separately accepted reaction plus fresh remount readback", async () => {
	await emptyA();
	held = { release: null, status: 503, emoji: "👍" };
	await choose("👍");
	await until(() => !!held?.release);
	expect(allReactions()).toEqual([own("👍")]);
	await choose("🎉");
	await until(() =>
		calls.some((call) => call.method === "POST" && call.status === 200)
	);
	expect(allReactions()).toEqual([own("👍"), own("🎉")]);
	expect(saved.A.map((row) => row.emoji)).toEqual(["🎉"]);
	await finishFailedThumbs();
	expect(allReactions()).toEqual([own("🎉")]);
	await act(async () => root?.unmount());
	root = undefined;
	queryClient.clear();
	await render();
	await until(() => allReactions().some((row) => row.emoji === "🎉"));
	expect(allReactions()).toEqual([own("🎉")]);
});
test("older refused same-emoji Add cannot erase the later accepted Add after a quick Remove", async () => {
	await emptyA();
	held = { release: null, status: 503, emoji: "👍" };
	await choose("👍");
	await until(() => !!held?.release);
	await choose("👍");
	await until(() =>
		calls.some((call) => call.method === "DELETE" && call.status === 200)
	);
	expect(allReactions()).toEqual([]);
	await choose("👍");
	await until(() =>
		calls.some((call) => call.method === "POST" && call.status === 200)
	);
	expect(allReactions()).toEqual([own("👍")]);
	await finishFailedThumbs();
	expect(allReactions()).toEqual([own("👍")]);
	expect(saved.A).toEqual([
		{ message_id: MESSAGE, emoji: "👍", count: 1, reacted_by_me: true },
	]);
	expect(
		calls
			.filter((call) => call.method !== "GET")
			.map((call) => ({
				method: call.method,
				body: call.body,
				status: call.status,
			}))
	).toEqual([
		{ method: "POST", body: { emoji: "👍" }, status: 503 },
		{ method: "DELETE", body: { emoji: "👍" }, status: 200 },
		{ method: "POST", body: { emoji: "👍" }, status: 200 },
	]);
});

test("old A refusal after real A→B→A selection cannot erase a newly accepted returning A emoji", async () => {
	await emptyA();
	held = { release: null, status: 503, emoji: "👍" };
	await choose("👍");
	await until(() => !!held?.release);
	await select("token");
	await until(() => state()?.count === 7);
	await select("A");
	await choose("🎉");
	await until(() =>
		calls.some(
			(call) =>
				call.slot === "A" && call.method === "POST" && call.status === 200
		)
	);
	expect(saved.A.map((row) => row.emoji)).toEqual(["🎉"]);
	await finishFailedThumbs();
	expect(allReactions()).toEqual([own("🎉")]);
	expect(saved.token).toEqual([
		{ message_id: MESSAGE, emoji: "✅", count: 7, reacted_by_me: true },
	]);
});

test("refused membership change preserves a same-emoji peer delta arriving while native write is pending", async () => {
	saved.A = [
		{ message_id: MESSAGE, emoji: "👍", count: 2, reacted_by_me: false },
	];
	await render();
	await until(() =>
		consumed.some((call) => call.slot === "A" && call.method === "GET")
	);
	held = { release: null, status: 503, emoji: "👍" };
	await choose("👍");
	await until(() => !!held?.release);
	expect(allReactions()).toEqual([{ ...own("👍"), count: 3 }]);
	// The real hook frame callback boundary; genuine socket delivery is outside this mounted scope.
	saved.A = [
		{ message_id: MESSAGE, emoji: "👍", count: 3, reacted_by_me: false },
	];
	const peer = [...container.querySelectorAll("button")].find(
		(row) => row.textContent === "Deliver peer frame"
	);
	if (!peer) throw new Error("Missing frame delivery adapter");
	await act(async () => peer.click());
	await until(() => allReactions()[0]?.count === 4);
	expect(allReactions()).toEqual([{ ...own("👍"), count: 4 }]);
	await finishFailedThumbs();
	expect(allReactions()).toEqual([
		{ ...own("👍"), count: 3, reactedByMe: false },
	]);
	expect(saved.A[0]).toMatchObject({ count: 3, reacted_by_me: false });
});
