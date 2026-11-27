// apps/desktop/src/hooks/useOperationsStream.test.tsx
//
// The app-wide feed of the operations store, against a stand-in node over
// real HTTP: one list per node connect, the stream only while something is
// queued or running, its events, a dropped stream, and a node switch.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const nativeAbortController = globalThis.AbortController;
const nativeAbortSignal = globalThis.AbortSignal;
const nativeReadableStream = globalThis.ReadableStream;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Happy DOM replaces these globals and Bun's native fetch refuses its
// AbortSignal, so the stream would never open. Keep the runtime's own, as the
// downloads stream suite does.
Reflect.set(globalThis, "AbortController", nativeAbortController);
Reflect.set(globalThis, "AbortSignal", nativeAbortSignal);
Reflect.set(globalThis, "ReadableStream", nativeReadableStream);
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useOperationsStore } = await import(
	"@/src/store/useOperationsStore.ts"
);
const { useOperationsStream } = await import("./useOperationsStream.ts");

const LIST = "/api/operations";
const STREAM = "/api/operations/stream";
const LONG = 15_000;

interface Connection {
	closed: boolean;
	controller?: ReadableStreamDefaultController<Uint8Array>;
}

let root: Root;
let container: HTMLDivElement;
let server: ReturnType<typeof Bun.serve>;
let originalNodeState: ReturnType<typeof useNodeStore.getState>;
let unexpected: string[];
let lists: number;
let streams: Connection[];
/** What the list answers. `null` is a node without the operations service. */
let listed: unknown[] | null;
/** What a new stream connection starts with. */
let snapshot: unknown[];

function at(seconds: number): string {
	return new Date(Date.UTC(2026, 10, 18, 10, 0, seconds)).toISOString();
}

/** One operation as the node serializes it. */
function wire(over: Record<string, unknown> = {}) {
	return {
		attempt: 1,
		cancelRequested: false,
		createdAt: at(0),
		id: "op_1",
		kind: "import.setup",
		progress: { done: 1, total: 12 },
		resumable: true,
		resumed: false,
		status: "running",
		title: ".claude",
		updatedAt: at(0),
		...over,
	};
}

function frame(event: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function wireEvent(type: "update", operation: unknown) {
	return { operation, type };
}

function send(connection: Connection | undefined, event: unknown) {
	connection?.controller?.enqueue(frame(event));
}

function mirror() {
	return useOperationsStore.getState().operations;
}

function Consumer() {
	useOperationsStream();
	return null;
}

async function settle(ms: number) {
	await act(async () => {
		await Bun.sleep(ms);
	});
}

async function until(predicate: () => boolean, what: string) {
	const end = Date.now() + 6000;
	while (!predicate()) {
		if (Date.now() > end) {
			throw new Error(
				`Timed out waiting for ${what}: ${JSON.stringify({
					lists,
					mirror: mirror(),
					streams: streams.map((s) => s.closed),
				})}`
			);
		}
		await settle(10);
	}
}

async function mount() {
	await act(async () => root.render(<Consumer />));
	await until(() => lists > 0, "the first list");
}

beforeEach(() => {
	originalNodeState = useNodeStore.getState();
	unexpected = [];
	lists = 0;
	streams = [];
	listed = [];
	snapshot = [];
	globalThis.fetch = Object.assign(
		(...args: Parameters<typeof nativeFetch>) => nativeFetch(...args),
		{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
	);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (request.method !== "GET" || !(path === LIST || path === STREAM)) {
				unexpected.push(`${request.method} ${path}`);
				return new NativeResponse("Unknown route", { status: 503 });
			}
			if (path === LIST) {
				lists += 1;
				return listed === null
					? NativeResponse.json({ error: "not found" }, { status: 404 })
					: NativeResponse.json({ operations: listed });
			}
			const connection: Connection = { closed: false };
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					connection.controller = controller;
					streams.push(connection);
					controller.enqueue(frame({ operations: snapshot, type: "snapshot" }));
					request.signal.addEventListener(
						"abort",
						() => {
							connection.closed = true;
						},
						{ once: true }
					);
				},
				cancel() {
					connection.closed = true;
				},
			});
			return new NativeResponse(body, {
				headers: {
					"cache-control": "no-cache",
					"content-type": "text/event-stream",
				},
			});
		},
	});
	useNodeStore.setState({
		nodes: [
			{
				name: "operations-proof",
				token: "node-a",
				url: server.url.toString().replace(/\/$/, ""),
				userJwt: "user-a",
			},
		],
		defaultNode: "operations-proof",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	useOperationsStore.getState().reset();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	server.stop(true);
	container.remove();
	globalThis.fetch = nativeFetch;
	useNodeStore.setState(originalNodeState);
	useOperationsStore.getState().reset();
	if (unexpected.length > 0) {
		throw new Error(`Unexpected requests: ${JSON.stringify(unexpected)}`);
	}
});

test(
	"reads the list once on connect and opens no stream while nothing runs",
	async () => {
		listed = [wire({ status: "succeeded", updatedAt: at(9) })];
		await mount();
		await until(() => mirror().op_1 !== undefined, "the listed operation");
		await settle(150);
		expect(mirror().op_1?.status).toBe("succeeded");
		expect(lists).toBe(1);
		expect(streams).toHaveLength(0);
	},
	LONG
);

test(
	"a node without the operations service shows nothing and opens no stream",
	async () => {
		listed = null;
		await mount();
		await settle(150);
		expect(mirror()).toEqual({});
		expect(streams).toHaveLength(0);
	},
	LONG
);

test(
	"follows the stream while an operation runs and closes it when the last one ends",
	async () => {
		listed = [wire()];
		snapshot = [wire(), wire({ id: "op_2", title: ".cursor" })];
		await mount();
		await until(() => streams.length === 1, "the stream");
		await until(() => mirror().op_2 !== undefined, "the snapshot");

		send(
			streams[0],
			wireEvent(
				"update",
				wire({ progress: { done: 5, total: 12 }, updatedAt: at(1) })
			)
		);
		await until(() => mirror().op_1?.progress.done === 5, "the update");

		send(streams[0], { id: "op_2", type: "removed" });
		await until(() => mirror().op_2 === undefined, "the removal");
		expect(streams[0]?.closed).toBe(false);

		send(
			streams[0],
			wireEvent(
				"update",
				wire({
					progress: { done: 12, total: 12 },
					status: "succeeded",
					updatedAt: at(2),
				})
			)
		);
		await until(() => streams[0]?.closed === true, "the closed stream");
		expect(mirror().op_1?.status).toBe("succeeded");
		await settle(700);
		expect(streams).toHaveLength(1);
	},
	LONG
);

test(
	"opens the stream again after the node drops it",
	async () => {
		listed = [wire()];
		snapshot = [wire()];
		await mount();
		await until(() => streams.length === 1, "the stream");
		await until(() => mirror().op_1 !== undefined, "the snapshot");

		snapshot = [wire({ progress: { done: 7, total: 12 }, updatedAt: at(3) })];
		streams[0]?.controller?.close();
		await until(() => streams.length === 2, "the second stream");
		await until(
			() => mirror().op_1?.progress.done === 7,
			"the snapshot of the second stream"
		);
	},
	LONG
);

test(
	"a node switch clears the mirror and reads the new node's list",
	async () => {
		listed = [wire({ status: "succeeded", updatedAt: at(9) })];
		await mount();
		await until(() => mirror().op_1 !== undefined, "the listed operation");

		listed = [wire({ id: "op_other", status: "failed", updatedAt: at(9) })];
		await act(async () =>
			useNodeStore.setState((s) => ({
				nodes: s.nodes.map((n) => ({ ...n, token: "node-b" })),
			}))
		);
		await until(() => lists === 2, "the second list");
		await until(() => mirror().op_other !== undefined, "the new node's list");
		expect(mirror().op_1).toBeUndefined();
		expect(streams).toHaveLength(0);
	},
	LONG
);
