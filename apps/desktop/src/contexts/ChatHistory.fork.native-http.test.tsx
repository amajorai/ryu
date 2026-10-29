import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
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
const SOURCE = "shared-/chat";
const SOURCE_PATH = encodeURIComponent(SOURCE);
const MESSAGE = "56093e30-7437-4f4c-8509-39c3842376b4";
const sourceMessages = [
	{
		id: "26142214-91fe-4835-be6e-a78726f61365",
		role: "user",
		content: "First persisted prompt",
		created_at: 1,
	},
	{
		id: MESSAGE,
		role: "assistant",
		content: "Persisted answer at fork boundary",
		created_at: 2,
	},
	{
		id: "26142214-91fe-4835-be6e-a78726f61366",
		role: "user",
		content: "Later prompt excluded from selected fork",
		created_at: 3,
	},
];
const calls: Array<{
	slot: Slot;
	method: string;
	path: string;
	body: unknown;
	status: number;
}> = [];
const unexpected: string[] = [];
const results: Array<string | null> = [];
let mode: "url" | "token" | "jwt" = "url";
let responseStatus = 200;
let missingConversation = false;
let gate: { release: (() => void) | null; status: number } | null = null;
const operations = new Set<Promise<void>>();
let records: Record<Slot, Array<ReturnType<typeof summary>>>;
let histories: Record<string, typeof sourceMessages>;
function summary(slot: Slot, id = SOURCE) {
	return {
		id,
		title: `${slot} ${id === SOURCE ? "source" : "fork"}`,
		agent_id: null,
		archived: false,
		branch: null,
		created_at: 1,
		updated_at: 2,
		folder_path: null,
		worktree_path: null,
		message_count: id === SOURCE ? 3 : 2,
		run_status: null,
		visibility: "private",
	};
}
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
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const node = targets().find(
			(candidate) =>
				candidate.url === url.origin + "/" + url.pathname.split("/")[1] &&
				request.headers.get("authorization") === `Bearer ${candidate.token}` &&
				request.headers.get("x-ryu-user-jwt") === candidate.userJwt
		);
		const match = /^\/(A|B)\/api\/conversations(?:\/([^/]+)(\/fork)?)?$/.exec(
			url.pathname
		);
		const list = match && !match[2] && request.method === "GET";
		const fork =
			match &&
			match[2] === SOURCE_PATH &&
			match[3] === "/fork" &&
			request.method === "POST";
		const history = match && match[2] && !match[3] && request.method === "GET";
		if (
			!node ||
			!match ||
			!(list || fork || history) ||
			!["", "?preview=1"].includes(url.search)
		) {
			unexpected.push(`${request.method} ${request.url}`);
			return NativeResponse.json(
				{ error: "Unimplemented fork proof request" },
				{ status: 503 }
			);
		}
		const slot = node.name as Slot;
		const body: unknown = fork ? await request.json() : null;
		const call = {
			slot,
			method: request.method,
			path: url.pathname,
			body,
			status: 200,
		};
		calls.push(call);
		if (list) return NativeResponse.json({ conversations: records[slot] });
		if (history) {
			const messages = histories[slot + ":" + decodeURIComponent(match[2]!)];
			if (!messages) {
				unexpected.push("Unknown history");
				return NativeResponse.json({}, { status: 404 });
			}
			return NativeResponse.json({ messages });
		}
		expect(request.headers.get("content-type")).toContain("application/json");
		if (body === null || typeof body !== "object") {
			unexpected.push("Invalid fork request body");
			return NativeResponse.json({ error: "Invalid fork request body" }, { status: 400 });
		}
		expect(Object.keys(body)).toEqual(
			Object.keys(body).length ? ["message_id"] : []
		);
		const status = gate?.status ?? responseStatus;
		const held = gate;
		if (held)
			await new Promise<void>((resolve) => {
				held.release = resolve;
			});
		call.status = status;
		if (status !== 200)
			return NativeResponse.json({ error: "Fork refused" }, { status });
		if (missingConversation) return NativeResponse.json({ ok: true });
		const id = slot + "-fork";
		const boundary = (body as { message_id?: string }).message_id;
		if (boundary && boundary !== MESSAGE) {
			unexpected.push("Incorrect fork boundary");
			return NativeResponse.json({}, { status: 400 });
		}
		histories[slot + ":" + id] = sourceMessages.slice(0, boundary ? 2 : 3);
		records[slot] = [summary(slot, id), ...records[slot]];
		return NativeResponse.json({ conversation: summary(slot, id) });
	},
});
function select(slot: Slot) {
	useNodeStore.setState({
		nodes: targets(),
		defaultNode: slot,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
}
function Probe() {
	const history = useChatHistoryContext();
	const [id, setId] = useState<string | null | undefined>();
	const [loaded, setLoaded] = useState<unknown>(null);
	const run = (whole = false) => {
		const op = history
			.forkConversation(SOURCE, whole ? undefined : MESSAGE)
			.then((next) => {
				results.push(next);
				setId(next);
			});
		operations.add(op);
		void op.finally(() => operations.delete(op));
	};
	return (
		<>
			<output data-testid="rows">
				{JSON.stringify(
					history.conversations.map((row) => ({ id: row.id, title: row.title }))
				)}
			</output>
			<output data-testid="result">{JSON.stringify(id ?? null)}</output>
			<output data-testid="history">{JSON.stringify(loaded)}</output>
			<button onClick={() => run()}>Fork selected message</button>
			<button onClick={() => run(true)}>Fork whole conversation</button>
			<button
				onClick={() => {
					if (id) {
						const op = history
							.loadMessages(id)
							.then((messages) => setLoaded(messages));
						operations.add(op);
						void op.finally(() => operations.delete(op));
					}
				}}
			>
				Load fork history
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
		root!.render(
			<ChatHistoryProvider>
				<Probe />
			</ChatHistoryProvider>
		)
	);
}
async function unmount() {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
}
function rows(): Array<{ id: string; title: string }> {
	return JSON.parse(
		container.querySelector('[data-testid="rows"]')!.textContent!
	);
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 250; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 4));
		});
		if (predicate()) return;
	}
	throw new Error(
		"Native fork result did not settle: " +
			container.textContent +
			"; calls=" +
			JSON.stringify(calls)
	);
}
async function click(label: string) {
	const button = [...container.querySelectorAll("button")].find(
		(node) => node.textContent === label
	);
	if (!button) throw new Error("Missing actual provider probe action");
	await act(async () => button.click());
}
beforeEach(() => {
	calls.length = unexpected.length = results.length = 0;
	mode = "url";
	responseStatus = 200;
	missingConversation = false;
	gate = null;
	records = { A: [summary("A")], B: [summary("B")] };
	histories = {};
	localStorage.clear();
	select("A");
});
afterEach(async () => {
	gate?.release?.();
	gate = null;
	await act(async () => {
		await Promise.all([...operations]);
	});
	await unmount();
	useNodeStore.setState(initialStore, true);
	expect(unexpected).toEqual([]);
	expect(operations.size).toBe(0);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});
test("selected-message fork uses exact escaped source and cutoff, lists the returned conversation and loads its persisted prefix on a fresh mount", async () => {
	await mount();
	await until(() => rows().some((row) => row.title === "A source"));
	await click("Fork selected message");
	await until(
		() => results.length === 1 && rows().some((row) => row.id === "A-fork")
	);
	expect(results).toEqual(["A-fork"]);
	expect(calls.filter((call) => call.method === "POST")).toEqual([
		{
			slot: "A",
			method: "POST",
			path: "/A/api/conversations/" + SOURCE_PATH + "/fork",
			body: { message_id: MESSAGE },
			status: 200,
		},
	]);
	await click("Load fork history");
	await until(
		() =>
			container.querySelector('[data-testid="history"]')!.textContent !== "null"
	);
	const messages = JSON.parse(
		container.querySelector('[data-testid="history"]')!.textContent!
	);
	expect(messages.map((message: { id: string }) => message.id)).toEqual(
		sourceMessages.slice(0, 2).map((message) => message.id)
	);
	expect(JSON.stringify(messages)).not.toContain(sourceMessages[2]!.content);
	await unmount();
	await mount();
	await until(() => rows().some((row) => row.id === "A-fork"));
	expect(rows()).toEqual([
		{ id: "A-fork", title: "A fork" },
		{ id: SOURCE, title: "A source" },
	]);
	expect(records.B).toEqual([summary("B")]);
});
test("whole-conversation fork sends empty JSON instead of a cutoff from a previous selected-message request", async () => {
	await mount();
	await until(() => rows().length === 1);
	await click("Fork whole conversation");
	await until(() => results.length === 1);
	expect(
		calls.filter((call) => call.method === "POST").map((call) => call.body)
	).toEqual([{}]);
	expect(histories["A:A-fork"]).toEqual(sourceMessages);
});
for (const failure of ["http", "missing-conversation"] as const)
	test(`fork ${failure} failure publishes no draft/new ID; explicit retry sends the same cutoff and fresh list reads the accepted fork`, async () => {
		await mount();
		await until(() => rows().length === 1);
		responseStatus = failure === "http" ? 503 : 200;
		missingConversation = failure === "missing-conversation";
		await click("Fork selected message");
		await until(() => results.length === 1);
		expect(results).toEqual([null]);
		expect(rows()).toEqual([{ id: SOURCE, title: "A source" }]);
		expect(records.A).toEqual([summary("A")]);
		responseStatus = 200;
		missingConversation = false;
		await click("Fork selected message");
		await until(() => results.length === 2 && rows().length === 2);
		expect(results).toEqual([null, "A-fork"]);
		expect(
			calls.filter((call) => call.method === "POST").map((call) => call.body)
		).toEqual([{ message_id: MESSAGE }, { message_id: MESSAGE }]);
		await unmount();
		await mount();
		await until(() => rows().length === 2);
		expect(rows()[0]?.id).toBe("A-fork");
	});
for (const rotation of ["url", "token", "jwt"] as const)
	test(`late successful A fork after ${rotation} authority rotation cannot insert A's returned row into B or return a usable ID to the old caller`, async () => {
		mode = rotation;
		select("A");
		await mount();
		await until(() => rows().some((row) => row.title === "A source"));
		gate = { release: null, status: 200 };
		await click("Fork selected message");
		await until(() => !!gate?.release);
		await act(async () => select("B"));
		await until(() => rows().some((row) => row.title === "B source"));
		const pending = gate;
		gate = null;
		await act(async () => pending.release?.());
		await until(() => results.length === 1);
		expect(results).toEqual([null]);
		expect(rows()).toEqual([{ id: SOURCE, title: "B source" }]);
		expect(records.A[0]?.id).toBe("A-fork");
		expect(records.B).toEqual([summary("B")]);
		expect(
			calls.filter((call) => call.method === "POST").map((call) => call.slot)
		).toEqual(["A"]);
	});

test("returning A after A-to-B-to-A still cancels the old fork navigation intent; an explicit fresh list can recover the persisted background fork", async () => {
	await mount();
	await until(() => rows().some((row) => row.title === "A source"));
	gate = { release: null, status: 200 };
	await click("Fork selected message");
	await until(() => !!gate?.release);
	await act(async () => select("B"));
	await until(() => rows().some((row) => row.title === "B source"));
	await act(async () => select("A"));
	await until(() => rows().some((row) => row.title === "A source"));
	const pending = gate;
	gate = null;
	await act(async () => pending.release?.());
	await until(() => results.length === 1);
	expect(results).toEqual([null]);
	expect(rows()).toEqual([{ id: SOURCE, title: "A source" }]);
	expect(records.A[0]?.id).toBe("A-fork");
	expect(records.B).toEqual([summary("B")]);
	await unmount();
	await mount();
	await until(() => rows().some((row) => row.id === "A-fork"));
	expect(rows()).toEqual([
		{ id: "A-fork", title: "A fork" },
		{ id: SOURCE, title: "A source" },
	]);
	expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
