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
// Happy DOM replaces these globals, and Bun's native fetch refuses a Happy DOM
// AbortSignal ("signal is not of type AbortSignal"), so the real HTTP stream
// never opens. Keep the runtime's own primitives, as the shared event consumer
// suite does.
Reflect.set(globalThis, "AbortController", nativeAbortController);
Reflect.set(globalThis, "AbortSignal", nativeAbortSignal);
Reflect.set(globalThis, "ReadableStream", nativeReadableStream);
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useDownloadsStore } = await import("@/src/store/useDownloadsStore.ts");
const { useInstallStore } = await import("@/src/store/useInstallStore.ts");
const { useDownloadsStream } = await import("./useDownloadsStream.ts");

import type { DownloadTask } from "@/src/lib/api/downloads.ts";

let root: Root;
let container: HTMLDivElement;
let server: ReturnType<typeof Bun.serve>;
let originalNodeState: ReturnType<typeof useNodeStore.getState>;
let signals: AbortSignal[];
let calls: Array<{
	token: string | null;
	jwt: string | null;
	controller?: ReadableStreamDefaultController<Uint8Array>;
	closed: boolean;
}>;
let unexpected: string[];
function task(owner: string): DownloadTask {
	return {
		id: "shared-job",
		label: owner,
		kind: "model",
		state: "active",
		received_bytes: 10,
		total_bytes: 100,
		speed_bps: 1,
		retryable: false,
		error: null,
		dest_path: null,
		url: null,
		created_at: 1,
		updated_at: 1,
	};
}
function Consumer() {
	useDownloadsStream();
	const tasks = useDownloadsStore((s) => s.tasks);
	return (
		<output>
			{Object.values(tasks)
				.map((t) => `${t.label}:${t.received_bytes}`)
				.join(",")}
		</output>
	);
}
async function until(predicate: () => boolean) {
	const end = Date.now() + 2500;
	while (!predicate()) {
		if (Date.now() > end) {
			throw new Error(
				"Real stream boundary timed out " +
					JSON.stringify({
						calls: calls.map((c) => ({
							token: c.token,
							jwt: c.jwt,
							closed: c.closed,
						})),
						view: container.textContent,
					})
			);
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
}
beforeEach(() => {
	originalNodeState = useNodeStore.getState();
	signals = [];
	calls = [];
	unexpected = [];
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof nativeFetch>) => {
			if (args[1]?.signal) {
				signals.push(args[1].signal);
			}
			return nativeFetch(...args);
		},
		{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
	);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			if (
				new URL(request.url).pathname !== "/api/events/all" ||
				request.method !== "GET"
			) {
				unexpected.push(request.url);
				return new NativeResponse("Unknown route", { status: 503 });
			}
			const token = request.headers.get("authorization");
			const jwt = request.headers.get("x-ryu-user-jwt");
			// Admit the original machine-only request so the regression can reach the live
			// stale-view boundary; assertions still demand selected explicit JWT forwarding.
			if (
				!(
					["Bearer node-a", "Bearer node-b"].includes(token ?? "") &&
					(jwt === null || jwt === "user-a" || jwt === "user-b")
				)
			) {
				unexpected.push("Unknown fixture authority");
				return new NativeResponse("Refused", { status: 401 });
			}
			const connection: (typeof calls)[number] = { token, jwt, closed: false };
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					connection.controller = controller;
					calls.push(connection);
					controller.enqueue(
						new TextEncoder().encode(
							`event: downloads\ndata: ${JSON.stringify({ type: "snapshot", tasks: [task(jwt === "user-b" ? "current-user" : "original-user")] })}\n\n`
						)
					);
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
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		},
	});
	useNodeStore.setState({
		nodes: [
			{
				name: "owned-proof",
				url: server.url.toString().replace(/\/$/, ""),
				token: "node-a",
				userJwt: "user-a",
			},
		],
		defaultNode: "owned-proof",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	useDownloadsStore.getState().reset();
	useInstallStore.getState().reset();
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
	useDownloadsStore.getState().reset();
	useInstallStore.getState().reset();
	// Teardown refuses any request outside the fixture contract for every test.
	if (unexpected.length > 0) {
		throw new Error(
			`Unexpected fixture requests: ${JSON.stringify(unexpected)}`
		);
	}
});
async function mount() {
	await act(async () => root.render(<Consumer />));
	await until(() => container.textContent === "original-user:10");
}
async function rotate(field: "token" | "userJwt", value: string) {
	await act(async () =>
		useNodeStore.setState((s) => ({
			nodes: s.nodes.map((n) => ({ ...n, [field]: value })),
		}))
	);
}
test("download snapshot forwards selected native delegation JWT through actual shared HTTP stream", async () => {
	await mount();
	expect(calls[0]?.token).toBe("Bearer node-a");
	expect(calls[0]?.jwt).toBe("user-a");
});
test("same-URL delegated account rotation drops old progress and receives only new authenticated download updates", async () => {
	await mount();
	const oldSignal = signals[0];
	useInstallStore.getState().begin("owned-install");
	await rotate("userJwt", "user-b");
	await until(
		() => calls.length === 2 && container.textContent === "current-user:10"
	);
	expect(oldSignal?.aborted).toBe(true);
	expect(calls[1]?.jwt).toBe("user-b");
	expect(useInstallStore.getState().inFlight).toEqual({});
	const current = calls[1];
	if (!current?.controller) {
		throw new Error("Missing actual current stream");
	}
	current.controller.enqueue(
		new TextEncoder().encode(
			`event: downloads\ndata: ${JSON.stringify({ type: "update", task: { ...task("current-user"), received_bytes: 75 } })}\n\n`
		)
	);
	await until(() => container.textContent === "current-user:75");
	expect(useDownloadsStore.getState().tasks["shared-job"]?.received_bytes).toBe(
		75
	);
});
test("node-token rotation cancels previous feed while preserving selected user JWT, and real EOF reconnects", async () => {
	await mount();
	const oldSignal = signals[0];
	await rotate("token", "node-b");
	await until(() => calls.length === 2);
	expect(oldSignal?.aborted).toBe(true);
	expect(calls[1]?.token).toBe("Bearer node-b");
	expect(calls[1]?.jwt).toBe("user-a");
	const current = calls[1];
	if (!current?.controller) {
		throw new Error("Missing replacement stream");
	}
	current.controller.close();
	await until(() => calls.length === 3);
	expect(calls[2]?.token).toBe("Bearer node-b");
	expect(calls[2]?.jwt).toBe("user-a");
});
