import { expect, spyOn, test } from "bun:test";
import { cancelCoreChatTurn } from "./core-chat.tsx";

const target = { token: "node-token", url: "http://127.0.0.1:7980/" };

test("Stop cancels the conversation's saved turn on Core", async () => {
	// Core keeps a saved turn running after its stream is aborted, so the
	// widget's Stop must also call the cancel endpoint.
	const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ cancelled: true })
	);
	try {
		expect(await cancelCoreChatTurn(target, "assistant-widget-1")).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://127.0.0.1:7980/api/chat/cancel");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe(
			JSON.stringify({ conversation_id: "assistant-widget-1" })
		);
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer node-token"
		);
	} finally {
		fetchMock.mockRestore();
	}
});

test("Stop stays best-effort when Core is unreachable or idle", async () => {
	const offline = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("offline")
	);
	try {
		expect(await cancelCoreChatTurn(target, "assistant-widget-2")).toBe(false);
	} finally {
		offline.mockRestore();
	}
	const idle = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ cancelled: false })
	);
	try {
		expect(await cancelCoreChatTurn(target, "assistant-widget-2")).toBe(false);
	} finally {
		idle.mockRestore();
	}
});
