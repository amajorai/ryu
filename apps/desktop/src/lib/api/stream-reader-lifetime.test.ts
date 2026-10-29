import { afterAll, afterEach, expect, mock, test } from "bun:test";
import type { ChannelStatus } from "./channelStatus.ts";
import type { TrafficEvent } from "./gateway.ts";

let response: Response;
let statuses: ChannelStatus[] = [];
let streamCalls = 0;
const originalFetch = globalThis.fetch;
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: { getItem: () => "fixture-token" },
});
mock.module("./client.ts", () => ({
	// `gateway.ts` (reached through `notifications.ts`) checks `instanceof ApiError`.
	ApiError: class ApiError extends Error {},
	authenticatedFetch: () => Promise.resolve(response),
	apiUrl: (target: { url: string }, path: string) => target.url + path,
	requestHeaders: () => Promise.resolve({}),
	request: () => Promise.resolve({}),
}));
mock.module("./system.ts", () => ({ restartGateway: () => Promise.resolve() }));
mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: "http://fixture.test",
	TOKEN_KEY: "fixture",
	// The node store's desktop-route sync reads the signed-in account.
	getActiveUserId: () => null,
	getActiveToken: () => globalThis.localStorage?.getItem("fixture") ?? null,
}));
mock.module("@/lib/core-url.ts", () => ({
	DEFAULT_CORE_URL: "http://fixture.test",
}));
const { streamUserNotifications } = await import("./notifications.ts");
const { streamDashboardEvents } = await import("./dashboard.ts");
const { streamMeetingEvents } = await import("./meetings.ts");
const { streamActivityChat } = await import("./shadow.ts");
const { subscribeGatewayTraffic } = await import("./gateway.ts");
const { subscribeChannelStatus } = await import("./channelStatus.ts");
const target = { url: "http://fixture.test", token: null };
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		cleanup();
	}
	globalThis.fetch = originalFetch;
	statuses = [];
	streamCalls = 0;
});
afterAll(() => {
	if (storage) {
		Object.defineProperty(globalThis, "localStorage", storage);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});
function source(text: string, closed = false) {
	let cancelled = 0;
	let control: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			control = controller;
			controller.enqueue(new TextEncoder().encode(text));
			if (closed) {
				controller.close();
			}
		},
		cancel() {
			cancelled += 1;
		},
	});
	cleanups.push(() => {
		try {
			control.close();
		} catch {}
	});
	response = new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0]) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.endsWith("/status")) {
				return Response.json({ statuses });
			}
			streamCalls += 1;
			return response;
		},
		{ preconnect: originalFetch.preconnect }
	);
	return { body, cancelled: () => cancelled };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Stream cleanup timed out")),
					2000
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function until(predicate: () => boolean) {
	await bounded(
		(async () => {
			while (!predicate()) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		})()
	);
}
const frame = (id: string) =>
	`data: ${JSON.stringify({ id, type: "dashboard_updated", dashboard_id: "fixture", title: "Fixture", level: "info" })}\n\n`;
// The notification consumer validates its publisher's complete event shape,
// so its frames carry those fields.
const notificationFrame = (id: string) =>
	`data: ${JSON.stringify({ level: "info", notification_id: id, title: id })}\n\n`;
const cases: {
	name: string;
	frame: (id: string) => string;
	invoke: (callback: () => void, signal: AbortSignal) => Promise<void>;
}[] = [
	{
		name: "notifications",
		frame: notificationFrame,
		invoke: (callback, signal) =>
			streamUserNotifications(target, "fixture", callback, signal),
	},
	{
		name: "dashboard",
		frame,
		invoke: (callback, signal) =>
			streamDashboardEvents(target, callback, signal),
	},
	{
		name: "meetings",
		frame,
		invoke: (callback, signal) => streamMeetingEvents(target, callback, signal),
	},
	{
		name: "Shadow",
		frame,
		invoke: (callback, signal) =>
			streamActivityChat("Fixture", [], callback, signal),
	},
];
for (const item of cases) {
	test(`${item.name} clean EOF releases its reader and preserves valid frames`, async () => {
		const stream = source(`data: invalid\n\n${item.frame("first")}`, true);
		let calls = 0;
		await bounded(
			item.invoke(() => {
				calls += 1;
			}, new AbortController().signal)
		);
		expect(calls).toBe(1);
		expect(stream.body.locked).toBe(false);
	});
	test(`${item.name} abort stops buffered events and cancels its reader`, async () => {
		const stream = source(item.frame("first") + item.frame("late"));
		const controller = new AbortController();
		let calls = 0;
		await bounded(
			item.invoke(() => {
				calls += 1;
				controller.abort();
			}, controller.signal)
		);
		expect(calls).toBe(1);
		expect(stream.cancelled()).toBe(1);
		expect(stream.body.locked).toBe(false);
	});
}
test("notification consumer failure releases the stream", async () => {
	const stream = source(notificationFrame("first"));
	await expect(
		streamUserNotifications(target, "fixture", () => {
			throw new Error("Consumer stopped");
		})
	).rejects.toThrow("Consumer stopped");
	expect(stream.cancelled()).toBe(1);
	expect(stream.body.locked).toBe(false);
});
const trafficFrame = (requestId: string) => {
	const event: TrafficEvent = {
		api_key: "fixture",
		cache_hit: false,
		error: null,
		event_type: "chat",
		input_tokens: 1,
		latency_ms: 1,
		model: "fixture-model",
		output_tokens: 1,
		provider: "fixture-provider",
		request_id: requestId,
		session_id: null,
		ts: "2026-10-09T00:00:00Z",
	};
	return `event: traffic\ndata: ${JSON.stringify(event)}\n\n`;
};
test("Gateway traffic unsubscribe stops buffered events and releases its reader", async () => {
	const stream = source(trafficFrame("first") + trafficFrame("late"));
	let calls = 0;
	let stop = () => {};
	stop = subscribeGatewayTraffic(target, () => {
		calls += 1;
		stop();
	});
	cleanups.push(stop);
	await until(() => stream.cancelled() === 1 && !stream.body.locked);
	expect(calls).toBe(1);
});
const channelStatus = (id: string): ChannelStatus => ({
	id,
	state: "online",
	detail: null,
	lastHeartbeatAt: null,
});
const channelFrame = (id: string) =>
	`event: status\ndata: ${JSON.stringify(channelStatus(id))}\n\n`;
test("last channel subscriber releases the reader without restoring stale buffered state", async () => {
	const stream = source(channelFrame("first") + channelFrame("late"));
	let calls = 0;
	let stop = () => {};
	stop = subscribeChannelStatus((value) => {
		if (value.has("first")) {
			calls += 1;
			stop();
		}
	});
	cleanups.push(stop);
	await until(() => stream.cancelled() === 1 && !stream.body.locked);
	expect(calls).toBe(1);
	let initialSize = -1;
	const stopNext = subscribeChannelStatus((value) => {
		initialSize = value.size;
	});
	stopNext();
	expect(initialSize).toBe(0);
});
test("channel snapshot teardown does not start a stream or refill shared state", async () => {
	source("");
	statuses = [channelStatus("first"), channelStatus("late")];
	let calls = 0;
	let stop = () => {};
	stop = subscribeChannelStatus((value) => {
		if (value.has("first")) {
			calls += 1;
			stop();
		}
	});
	cleanups.push(stop);
	await until(() => calls === 1);
	let initialSize = -1;
	const stopNext = subscribeChannelStatus((value) => {
		initialSize = value.size;
	});
	stopNext();
	expect(initialSize).toBe(0);
	expect(streamCalls).toBe(0);
});
