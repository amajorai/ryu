import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let activeNode: ApiTarget = { token: null, url: "http://192.168.1.50:7980" };
const getRealtimeJwt = mock(async () => "account-jwt");
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => activeNode,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({ getRealtimeJwt }));

// The real RealtimeConnection runs: its WebSocket-ticket exchange is the request
// that carries the account JWT, so record it and refuse it before any socket.
const ticketRequests: Headers[] = [];
const originalFetch = globalThis.fetch;
Reflect.set(
	globalThis,
	"fetch",
	mock((input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).endsWith("/api/ws/ticket")) {
			ticketRequests.push(new Headers(init?.headers));
		}
		return Promise.resolve(new Response(null, { status: 401 }));
	})
);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useRealtimeRoom } = await import("./use-realtime-room.ts");

function ConversationRoom() {
	useRealtimeRoom("conversation-1", "conversation");
	return null;
}

async function joinConversationRoom(): Promise<Headers> {
	const root = createRoot(document.createElement("div"));
	await act(async () => {
		root.render(createElement(ConversationRoom));
	});
	for (let tick = 0; tick < 50 && ticketRequests.length === 0; tick++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	act(() => root.unmount());
	const headers = ticketRequests.at(-1);
	if (!headers) {
		throw new Error("Expected a realtime ticket request");
	}
	return headers;
}

afterAll(() => {
	Reflect.set(globalThis, "fetch", originalFetch);
});

beforeEach(() => {
	ticketRequests.length = 0;
	getRealtimeJwt.mockClear();
});

test("a node with no admission credential joins a chat room without the account JWT", async () => {
	// What LAN discovery saves, or a token-less `ryu://nodes/connect` link.
	activeNode = { token: null, url: "http://192.168.1.50:7980" };

	const headers = await joinConversationRoom();

	expect(headers.has("Authorization")).toBe(false);
	expect(headers.has("x-ryu-user-jwt")).toBe(false);
	expect(getRealtimeJwt).not.toHaveBeenCalled();
});

test("a node with its own bearer still joins with the signed-in identity", async () => {
	activeNode = { token: "node-secret", url: "https://node.example" };

	const headers = await joinConversationRoom();

	expect(headers.get("Authorization")).toBe("Bearer node-secret");
	expect(headers.get("x-ryu-user-jwt")).toBe("account-jwt");
});

test("a tokened node over cleartext HTTP joins with its bearer but no account JWT", async () => {
	activeNode = { token: "node-secret", url: "http://192.168.1.50:7980" };

	const headers = await joinConversationRoom();

	expect(headers.get("Authorization")).toBe("Bearer node-secret");
	expect(headers.has("x-ryu-user-jwt")).toBe(false);
	expect(getRealtimeJwt).not.toHaveBeenCalled();
});

test("a managed node over cleartext HTTP keeps its delegation", async () => {
	activeNode = {
		token: null,
		url: "http://10.0.0.5:7980",
		userJwt: "node-delegation",
	};

	const headers = await joinConversationRoom();

	expect(headers.get("Authorization")).toBe("Bearer node-delegation");
	expect(headers.get("x-ryu-user-jwt")).toBe("node-delegation");
	expect(getRealtimeJwt).not.toHaveBeenCalled();
});

test("a Core on this machine still joins with the signed-in identity", async () => {
	activeNode = { token: "node-secret", url: "http://127.0.0.1:7980" };

	const headers = await joinConversationRoom();

	expect(headers.get("Authorization")).toBe("Bearer node-secret");
	expect(headers.get("x-ryu-user-jwt")).toBe("account-jwt");
});
