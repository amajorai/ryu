// The generative-UI widget state host's write side: what it saves, what it
// refuses to save, and how a failed save falls back. A local Core stand-in
// records each PUT and can hold or refuse it.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AgentUiStateHost } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-host-context.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Put {
	body: unknown;
	path: string;
}
let listed: Record<string, unknown> = {};
const puts: Put[] = [];
// Each PUT waits on its own gate so a test decides when (and how) it settles.
let gates: ((status: number) => void)[] = [];
let holdPuts = false;
let putStatus = 200;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (request.method === "PUT") {
			puts.push({ body: await request.json(), path: pathname });
			const status = holdPuts
				? await new Promise<number>((resolve) => gates.push(resolve))
				: putStatus;
			return NativeResponse.json({ ok: status === 200 }, { status });
		}
		return NativeResponse.json({ states: listed });
	},
});
const node = {
	name: "local",
	token: "fixture-node",
	url: server.url.origin,
	userJwt: null,
};
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));

const { createRoot } = await import("react-dom/client");
const { useAgentUiStateHost } = await import("./useAgentUiStateHost.ts");
const { listAgentUiStates } = await import("@/src/lib/api/agent-ui-state.ts");

let host: AgentUiStateHost | null = null;
function Harness({ conversationId }: { conversationId: string }) {
	host = useAgentUiStateHost(conversationId);
	return null;
}

let root: Root | undefined;
let client: QueryClient;
let conversationCounter = 0;
let conversationId = "";

async function until(check: () => boolean) {
	for (let i = 0; i < 250; i++) {
		if (check()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 8));
		});
	}
	throw new Error("Timed out waiting for the condition");
}

async function mount() {
	// A fresh conversation per test: the host's write clock is module-level.
	conversationCounter += 1;
	conversationId = `chat-${conversationCounter}`;
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<Harness conversationId={conversationId} />
			</QueryClientProvider>
		)
	);
	await until(() => client.isFetching() === 0 && host !== null);
	// The fetch can settle before React re-renders and merges the read, so wait
	// until every listed record is visible through the host.
	await until(() =>
		Object.keys(listed).every((key) => host?.read(key) !== undefined)
	);
}

function current(): AgentUiStateHost {
	if (!host) {
		throw new Error("host not mounted");
	}
	return host;
}

beforeEach(() => {
	listed = {};
	puts.length = 0;
	gates = [];
	holdPuts = false;
	putStatus = 200;
	client = new QueryClient();
});
afterEach(async () => {
	for (const release of gates) {
		release(200);
	}
	await act(async () => root?.unmount());
	root = undefined;
	host = null;
	document.body.innerHTML = "";
	client.clear();
});
afterAll(() => server.stop(true));

test("a save PUTs {state: saved} to the widget's encoded ui-state route", async () => {
	await mount();
	await act(async () => {
		current().write("call/1", { state: { done: [true] }, title: "Tasks" });
	});
	await until(() => puts.length === 1);
	expect(puts[0]).toEqual({
		body: { state: { state: { done: [true] }, title: "Tasks" } },
		path: `/api/conversations/${conversationId}/ui-state/call%2F1`,
	});
	expect(current().read("call/1")).toEqual({
		state: { done: [true] },
		title: "Tasks",
	});
});

test("a record without a title keeps the title an earlier save stored", async () => {
	listed = { card: { state: { a: 1 }, title: "Checklist" } };
	await mount();
	await act(async () => {
		current().write("card", { state: { a: 2 } });
	});
	await until(() => puts.length === 1);
	expect(puts[0]?.body).toEqual({
		state: { state: { a: 2 }, title: "Checklist" },
	});
	expect(current().read("card")?.title).toBe("Checklist");
});

test("a record Core would refuse is never sent and the saved copy stays", async () => {
	listed = { form: { state: { name: "Ada" } } };
	await mount();
	const tooLarge = { state: { blob: "x".repeat(70 * 1024) } };
	let deep: Record<string, unknown> = { leaf: 1 };
	for (let level = 0; level < 40; level++) {
		deep = { next: deep };
	}
	await act(async () => {
		current().write("form", tooLarge);
		current().write("form", { state: deep });
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(puts).toEqual([]);
	expect(current().read("form")).toEqual({ state: { name: "Ada" } });
});

test("a failed save rolls the widget back to the copy Core still holds", async () => {
	listed = { form: { state: { name: "Ada" } } };
	// Held, so the optimistic copy is observed before the refusal lands.
	holdPuts = true;
	await mount();
	await act(async () => {
		current().write("form", { state: { name: "Grace" } });
	});
	await until(() => gates.length === 1);
	expect(current().read("form")).toEqual({ state: { name: "Grace" } });
	await act(async () => {
		gates[0]?.(500);
	});
	await until(() => current().read("form")?.state.name === "Ada");
	expect(current().read("form")).toEqual({ state: { name: "Ada" } });
});

test("a failed save does not roll back over a newer edit", async () => {
	listed = { form: { state: { name: "Ada" } } };
	holdPuts = true;
	await mount();
	await act(async () => {
		current().write("form", { state: { name: "Grace" } });
	});
	await until(() => gates.length === 1);
	await act(async () => {
		current().write("form", { state: { name: "Linus" } });
	});
	await until(() => gates.length === 2);
	await act(async () => {
		gates[0]?.(500);
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(current().read("form")).toEqual({ state: { name: "Linus" } });
	await act(async () => {
		gates[1]?.(200);
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(current().read("form")).toEqual({ state: { name: "Linus" } });
});

test("listAgentUiStates drops entries that do not match the saved shape", async () => {
	listed = {
		good: { state: { a: 1 }, submitted: true, title: "Ok" },
		lenient: { state: { b: 2 }, submitted: "yes", title: 7 },
		noState: { title: "x" },
		notObject: "junk",
		stateArray: { state: [1, 2] },
	};
	const states = await listAgentUiStates(
		{ token: "fixture-node", url: server.url.origin },
		"chat-x"
	);
	expect([...states.keys()].sort()).toEqual(["good", "lenient"]);
	expect(states.get("good")).toEqual({
		state: { a: 1 },
		submitted: true,
		title: "Ok",
	});
	expect(states.get("lenient")).toEqual({
		state: { b: 2 },
		submitted: undefined,
		title: undefined,
	});
});
