import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
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
let node = { url: "", token: "node-a", userJwt: "user-a" };
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
const { createRoot } = await import("react-dom/client");
const { Toaster, toast } = await import("@ryu/ui/components/sileo");
const { useDesktopNotificationsStream } = await import(
	"./useDesktopNotificationsStream.ts"
);
function Consumer() {
	useDesktopNotificationsStream();
	return <Toaster />;
}
interface Connection {
	closed: boolean;
	controller: ReadableStreamDefaultController<Uint8Array>;
	jwt: string | null;
	token: string | null;
}
let server: ReturnType<typeof Bun.serve>;
let root: Root;
let container: HTMLDivElement;
let requestSignals: (AbortSignal | null | undefined)[];
let connections: Connection[];
let calls: {
	method: string;
	path: string;
	token: string | null;
	jwt: string | null;
}[];
let unexpected: string[];
let refused: number;
let notices: { title: string; body?: string; click?: () => void }[];
let permission: NotificationPermission;
let permissionReads: number;
let success: ReturnType<typeof spyOn<typeof toast, "success">>;
let error: ReturnType<typeof spyOn<typeof toast, "error">>;
const originalNotification = globalThis.Notification;
class NativeNotificationBoundary {
	static get permission() {
		return permission;
	}
	static async requestPermission() {
		permissionReads++;
		return permission;
	}
	constructor(title: string, options?: NotificationOptions) {
		const entry = {
			title,
			body: options?.body,
			click: undefined as (() => void) | undefined,
		};
		notices.push(entry);
		Object.defineProperty(this, "onclick", {
			set(value: () => void) {
				entry.click = value;
			},
		});
	}
}
beforeEach(() => {
	requestSignals = [];
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof nativeFetch>): Promise<Response> => {
			requestSignals.push(args[1]?.signal);
			return nativeFetch(...args);
		},
		{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
	);
	Reflect.set(globalThis, "Notification", NativeNotificationBoundary);
	connections = [];
	calls = [];
	unexpected = [];
	refused = 0;
	notices = [];
	permission = "granted";
	permissionReads = 0;
	success = spyOn(toast, "success");
	error = spyOn(toast, "error");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			calls.push({
				method: request.method,
				path,
				token: request.headers.get("authorization"),
				jwt: request.headers.get("x-ryu-user-jwt"),
			});
			if (
				request.method !== "GET" ||
				path !== "/api/events/all" ||
				request.headers.get("accept") !== "text/event-stream"
			) {
				unexpected.push(`${request.method} ${path}`);
				return new NativeResponse("unexpected", { status: 503 });
			}
			const token = request.headers.get("authorization");
			const jwt = request.headers.get("x-ryu-user-jwt");
			if (
				!(
					(token === "Bearer node-a" &&
						(jwt === "user-a" || jwt === "user-b")) ||
					(token === "Bearer node-b" && jwt === "user-a")
				)
			) {
				unexpected.push("Unknown credential pair");
				return new NativeResponse("Unauthenticated fixture caller", {
					status: 401,
				});
			}
			if (refused-- > 0) {
				return new NativeResponse("temporarily unavailable", { status: 503 });
			}
			let connection: Connection;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					connection = {
						controller,
						closed: false,
						token: request.headers.get("authorization"),
						jwt: request.headers.get("x-ryu-user-jwt"),
					};
					connections.push(connection);
					request.signal.addEventListener(
						"abort",
						() => {
							connection.closed = true;
						},
						{ once: true }
					);
					controller.enqueue(new TextEncoder().encode(": connected\n\n"));
				},
				cancel() {
					connection.closed = true;
				},
			});
			return new NativeResponse(body, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	node = {
		url: server.url.toString().replace(/\/$/, ""),
		token: "node-a",
		userJwt: "user-a",
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => {
		for (const call of [...success.mock.results, ...error.mock.results]) {
			if (call.type === "return" && typeof call.value === "string") {
				toast.dismiss(call.value);
			}
		}
		await Bun.sleep(20);
		root.unmount();
	});
	server.stop(true);
	container.remove();
	success.mockRestore();
	error.mockRestore();
	globalThis.fetch = nativeFetch;
	Reflect.set(globalThis, "Notification", originalNotification);
	mock.restore();
});
async function until(condition: () => boolean) {
	const end = Date.now() + 3500;
	while (!condition()) {
		if (Date.now() > end) {
			throw new Error(
				"Timed out waiting for actual notification delivery " +
					JSON.stringify({
						calls,
						connections: connections.map(({ closed, token, jwt }) => ({
							closed,
							token,
							jwt,
						})),
					})
			);
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
}
async function render() {
	await act(async () => root.render(<Consumer />));
}
async function emit(
	connection: Connection,
	value: unknown,
	channel = "notifications"
) {
	// A physically closed stream cannot carry a late frame at all (the native
	// controller refuses it), which is the strongest form of "not delivered".
	if (connection.closed) {
		return;
	}
	await act(async () =>
		connection.controller.enqueue(
			new TextEncoder().encode(
				`event: ${channel}\ndata: ${JSON.stringify(value)}\n\n`
			)
		)
	);
}
function current() {
	const connection = connections.at(-1);
	if (!connection) {
		throw new Error("No real SSE connection");
	}
	return connection;
}
test("real notification SSE renders success and warning bodies and forwards exact OS payload", async () => {
	await render();
	await until(() => connections.length === 1);
	await emit(current(), {
		title: "App installed",
		body: "Clips is ready.",
		level: "success",
	});
	await until(
		() => container.textContent?.includes("Clips is ready.") === true
	);
	expect(success).toHaveBeenCalledWith({
		title: "App installed",
		description: "Clips is ready.",
	});
	expect(notices).toEqual([
		{
			title: "App installed",
			body: "Clips is ready.",
			click: expect.any(Function),
		},
	]);
	await emit(current(), {
		title: "Delegation incomplete",
		body: "One child failed.",
		level: "warning",
	});
	await until(
		() => container.textContent?.includes("One child failed.") === true
	);
	expect(error).toHaveBeenCalledWith({
		title: "Delegation incomplete",
		description: "One child failed.",
	});
	expect(notices[1]?.title).toBe("Delegation incomplete");
	expect(calls).toEqual([
		{
			method: "GET",
			path: "/api/events/all",
			token: "Bearer node-a",
			jwt: "user-a",
		},
	]);
	expect(unexpected).toEqual([]);
});
test("denied OS permission preserves real in-app delivery without constructing a notification", async () => {
	permission = "denied";
	await render();
	await until(() => connections.length === 1);
	await emit(current(), {
		title: "Import complete",
		body: "Four threads imported.",
	});
	await until(
		() => container.textContent?.includes("Four threads imported.") === true
	);
	expect(notices).toEqual([]);
	expect(permissionReads).toBe(0);
	expect(success).toHaveBeenCalledTimes(1);
	expect(unexpected).toEqual([]);
});
test("HTTP refusal retries the real stream and delivers the subsequent notification", async () => {
	refused = 1;
	await render();
	await until(() => connections.length === 1);
	expect(calls.length).toBe(2);
	expect(success).not.toHaveBeenCalled();
	await emit(current(), {
		title: "Thread imported",
		body: "Research is ready.",
	});
	await until(
		() => container.textContent?.includes("Research is ready.") === true
	);
	expect(notices[0]?.body).toBe("Research is ready.");
	expect(unexpected).toEqual([]);
});
for (const field of ["token", "userJwt"] as const) {
	test(`same-URL ${field} rotation closes old notification stream and authenticates new delivery`, async () => {
		await render();
		await until(() => connections.length === 1);
		const old = current();
		node = { ...node, [field]: field === "token" ? "node-b" : "user-b" };
		await render();
		await until(() => connections.length === 2);
		expect(requestSignals[0]?.aborted).toBe(true);
		await until(() => old.closed);
		await emit(old, {
			title: "Old authority late event",
			body: "Must not show.",
		});
		expect(calls.at(-1)).toEqual({
			method: "GET",
			path: "/api/events/all",
			token: field === "token" ? "Bearer node-b" : "Bearer node-a",
			jwt: field === "userJwt" ? "user-b" : "user-a",
		});
		await emit(current(), {
			title: `${field} authority complete`,
			body: `${field}: current account only.`,
		});
		await until(
			() =>
				container.textContent?.includes(`${field}: current account only.`) ===
				true
		);
		expect(success).toHaveBeenCalledTimes(1);
		expect(notices).toHaveLength(1);
		expect(unexpected).toEqual([]);
	});
}
