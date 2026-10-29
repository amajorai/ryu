// Unit tests for RyuYjsProvider's reconnect behaviour — the half of multiplayer
// durability that both CRDT surfaces (the notes editor and the database grid)
// depend on, because each constructs a provider directly instead of going
// through `useRealtimeRoom`.
//
// The bug these pin: `handleClose` left `this.connection` set, and `connect()`
// early-returns while a connection object exists, so a single dropped socket
// wedged the provider forever. The grid went on saying "Live" and every edit
// after that point was silently discarded.
//
// Driven through a stubbed global `WebSocket` (the transport constructs one
// internally), so these are real provider code paths with no network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RyuYjsProvider, type RyuYjsStatus } from "./yjs-provider.ts";

/** Core's CLOSE_POLICY — an ACL denial. */
const CLOSE_POLICY = 1008;
/** A normal abnormal-closure code (socket died). */
const CLOSE_ABNORMAL = 1006;

class FakeSocket {
	static instances: FakeSocket[] = [];

	binaryType = "";
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	readyState = 0;
	sent: unknown[] = [];

	constructor(public url: string) {
		FakeSocket.instances.push(this);
	}

	send(data: Parameters<WebSocket["send"]>[0]): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
	}

	/** Drive the open handshake the way a real socket would. */
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	/** Drive a close with the given code. */
	die(code: number): void {
		this.readyState = 3;
		this.onclose?.({ code });
	}
}

const originalWebSocket = globalThis.WebSocket;

function makeProvider(onStatusChange?: (s: RyuYjsStatus) => void) {
	return new RyuYjsProvider({
		roomId: "db_test",
		target: {
			fetch: async () =>
				new Response(JSON.stringify({ ticket: "test-ticket" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			url: "http://127.0.0.1:8980",
			token: null,
			userJwt: null,
		},
		jwt: null,
		handlers: { onStatusChange },
	});
}

/** Wait until `predicate` holds or the budget runs out (backoff is ~0.5–1s). */
async function waitFor(
	predicate: () => boolean,
	budgetMs = 2500
): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < budgetMs) {
		if (predicate()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

describe("RyuYjsProvider reconnect", () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: FakeSocket,
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: originalWebSocket,
		});
	});

	test("re-opens after the socket dies", async () => {
		const provider = makeProvider();
		provider.connect();
		expect(await waitFor(() => FakeSocket.instances.length === 1)).toBe(true);

		FakeSocket.instances[0].open();
		expect(provider.isConnected).toBe(true);

		FakeSocket.instances[0].die(CLOSE_ABNORMAL);
		expect(provider.isConnected).toBe(false);

		const reconnected = await waitFor(() => FakeSocket.instances.length > 1);
		expect(reconnected).toBe(true);

		// And the new socket completes the handshake, so the room is live again.
		FakeSocket.instances[1].open();
		expect(provider.isConnected).toBe(true);
		provider.destroy();
	});

	test("does not retry a 1008 policy close, and reports it as denied", async () => {
		const seen: RyuYjsStatus[] = [];
		const provider = makeProvider((s) => seen.push(s));
		provider.connect();
		expect(await waitFor(() => FakeSocket.instances.length === 1)).toBe(true);
		FakeSocket.instances[0].open();
		FakeSocket.instances[0].die(CLOSE_POLICY);

		// Retrying an ACL denial turns a permission error into a self-inflicted DoS
		// against the node, so this state must be terminal.
		await waitFor(() => FakeSocket.instances.length > 1);
		expect(FakeSocket.instances.length).toBe(1);
		expect(seen.at(-1)).toBe("denied");
		provider.destroy();
	});

	test("does not retry after the caller disconnects", async () => {
		const provider = makeProvider();
		provider.connect();
		expect(await waitFor(() => FakeSocket.instances.length === 1)).toBe(true);
		FakeSocket.instances[0].open();

		provider.disconnect();
		FakeSocket.instances[0].die(CLOSE_ABNORMAL);

		await waitFor(() => FakeSocket.instances.length > 1);
		expect(FakeSocket.instances.length).toBe(1);
	});

	test("reports reconnecting, then open again, so the UI can stop saying Live", async () => {
		const seen: RyuYjsStatus[] = [];
		const provider = makeProvider((s) => seen.push(s));
		provider.connect();
		expect(await waitFor(() => FakeSocket.instances.length === 1)).toBe(true);
		FakeSocket.instances[0].open();
		expect(seen).toContain("open");

		FakeSocket.instances[0].die(CLOSE_ABNORMAL);
		expect(seen.at(-1)).toBe("reconnecting");

		await waitFor(() => FakeSocket.instances.length > 1);
		FakeSocket.instances[1].open();
		expect(seen.at(-1)).toBe("open");
		provider.destroy();
	});

	test("does not double-send local updates after a reconnect", async () => {
		const provider = makeProvider();
		provider.connect();
		expect(await waitFor(() => FakeSocket.instances.length === 1)).toBe(true);
		FakeSocket.instances[0].open();
		FakeSocket.instances[0].die(CLOSE_ABNORMAL);

		await waitFor(() => FakeSocket.instances.length > 1);
		const socket = FakeSocket.instances[1];
		socket.open();
		const beforeEdit = socket.sent.length;

		// One local edit must produce exactly ONE outbound update frame. If the
		// close path left the doc listener attached while `connect()` attached a
		// second one, this would send twice.
		provider.document.getMap("cells").set("a", 1);
		expect(socket.sent.length - beforeEdit).toBe(1);
		provider.destroy();
	});
});
