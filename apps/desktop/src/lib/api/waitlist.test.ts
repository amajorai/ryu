import { describe, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { openWaitlistStream } from "./waitlist.ts";

const realFetch = globalThis.fetch;
const realLocalStorage = globalThis.localStorage;

function streamResponse(body: string): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(body));
			controller.close();
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream" },
	});
}

function setStorage(token: string | null): void {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => token },
	});
}

describe("openWaitlistStream", () => {
	test("sends bearer and cookie credentials and yields approval events", async () => {
		setStorage("desktop-token");
		let request: Request | undefined;
		globalThis.fetch = createFetchFixture(realFetch, (input, init) => {
			request = new Request(input, init);
			return Promise.resolve(
				streamResponse('event: waitlist\ndata: {"status":"approved"}\n\n')
			);
		});

		try {
			const messages = [];
			for await (const message of openWaitlistStream(
				new AbortController().signal
			)) {
				messages.push(message);
			}
			expect(request?.url).toContain("/api/waitlist/stream");
			expect(request?.headers.get("authorization")).toBe(
				"Bearer desktop-token"
			);
			expect(request?.credentials).toBe("include");
			expect(messages).toEqual([
				{ event: "waitlist", data: { status: "approved" } },
			]);
		} finally {
			globalThis.fetch = realFetch;
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: realLocalStorage,
			});
		}
	});

	test("still opens with cookie auth when no token is stored", async () => {
		setStorage(null);
		let request: Request | undefined;
		globalThis.fetch = createFetchFixture(realFetch, (input, init) => {
			request = new Request(input, init);
			return Promise.resolve(streamResponse('data: {"status":"approved"}\n\n'));
		});

		try {
			for await (const _message of openWaitlistStream(
				new AbortController().signal
			)) {
				break;
			}
			expect(request?.headers.has("authorization")).toBe(false);
			expect(request?.credentials).toBe("include");
		} finally {
			globalThis.fetch = realFetch;
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: realLocalStorage,
			});
		}
	});
});
