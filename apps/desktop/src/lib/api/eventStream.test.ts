import { afterEach, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { z } from "zod";
import type { ApprovalRequest } from "./approvals.ts";
import type { DownloadTask } from "./downloads.ts";
import {
	resetEventStreamIdleTimeoutForTests,
	streamChannel,
	subscribeChannel,
} from "./eventStream.ts";
import type { Quest } from "./quests.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		cleanup();
	}
});
async function until(predicate: () => boolean) {
	const end = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > end) {
			throw new Error("stream fixture timed out");
		}
		await Bun.sleep(10);
	}
}
test("shares matching scopes, isolates changed credentials and closes the last subscriber", async () => {
	const requests: string[] = [];
	let closed = 0;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			requests.push(
				`${request.headers.get("authorization")}/${request.headers.get("x-ryu-user-jwt")}`
			);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode('event: quests\ndata: {"ok":true}\n\n')
						);
					},
					cancel() {
						closed++;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const target = {
		url: server.url.toString(),
		token: "fixture-node",
		userJwt: "fixture-user",
	};
	let delivered = 0;
	const a = subscribeChannel(target, "quests", () => delivered++);
	const b = subscribeChannel(target, "activity", () => undefined);
	const c = subscribeChannel(
		{ ...target, token: "fixture-new-node" },
		"quests",
		() => delivered++
	);
	const d = subscribeChannel(
		{ ...target, userJwt: "fixture-new-user" },
		"quests",
		() => delivered++
	);
	cleanups.push(a, b, c, d);
	await until(() => delivered === 3);
	expect(requests.length).toBe(3);
	a();
	await Bun.sleep(20);
	expect(closed).toBe(0);
	b();
	c();
	d();
	await until(() => closed === 3);
	const controller = new AbortController();
	controller.abort();
	await streamChannel(
		target,
		"quests",
		() => undefined,
		controller.signal,
		z.object({ id: z.string() })
	);
	await Bun.sleep(20);
	expect(requests.length).toBe(3);
});

test("reconnect backoff releases completed abort listeners and cancels on unsubscribe", async () => {
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests++;
			return new Response("restart", { status: 503 });
		},
	});
	cleanups.push(() => server.stop(true));
	const OriginalController = globalThis.AbortController;
	const signals: AbortSignal[] = [];
	globalThis.AbortController = class extends OriginalController {
		constructor() {
			super();
			signals.push(this.signal);
		}
	};
	cleanups.push(() => {
		globalThis.AbortController = OriginalController;
	});
	const activeListenerCount = () =>
		signals
			.filter((candidate) => !candidate.aborted)
			.reduce(
				(sum, candidate) => sum + getEventListeners(candidate, "abort").length,
				0
			);
	const original = globalThis.fetch;
	let signal: AbortSignal | undefined;
	const counts: number[] = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			if (signal) {
				counts.push(activeListenerCount());
			}
			return await original(input, init);
		},
		{ preconnect: original.preconnect }
	);
	cleanups.push(() => {
		globalThis.fetch = original;
	});
	const unsubscribe = subscribeChannel(
		{ url: server.url.toString(), token: null, userJwt: "fixture-user" },
		"quests",
		() => undefined
	);
	cleanups.push(unsubscribe);
	await until(() => requests === 4);
	expect(counts).toEqual([1, 1, 1, 1]);
	unsubscribe();
	expect(signal?.aborted).toBe(true);
	expect(activeListenerCount()).toBe(0);
});

test("a dispatch failure cancels the current response before retrying", async () => {
	let closed = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode("event: quests\ndata: {}\n\n")
						);
					},
					cancel() {
						closed++;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const unsubscribe = subscribeChannel(
		{ url: server.url.toString(), token: null, userJwt: "fixture-user" },
		"quests",
		() => {
			throw new Error("fixture subscriber failed");
		}
	);
	cleanups.push(unsubscribe);
	await until(() => closed === 1);
	unsubscribe();
	expect(closed).toBe(1);
});

test("typed subscriptions ignore malformed payloads and retain native events and future fields", async () => {
	const { streamApprovalEvents } = await import("./approvals.ts");
	const { streamDownloads } = await import("./downloads.ts");
	const { streamMonitorAlerts } = await import("./monitors.ts");
	const { streamQuestEvents } = await import("./quests.ts");
	const approval = {
		id: "approval-1",
		kind: "tool_call",
		title: "Run tool",
		summary: "Read workspace",
		risk_tags: [],
		status: "pending",
		created_at: "2026-10-10T00:00:00Z",
		action: null,
		future: "retained",
	} satisfies ApprovalRequest & { future: string };
	const task = {
		id: "download-1",
		kind: "model",
		label: "Model",
		url: null,
		dest_path: null,
		total_bytes: null,
		received_bytes: 0,
		state: "active",
		error: null,
		retryable: true,
		speed_bps: null,
		created_at: 0,
		updated_at: 0,
		future: "retained",
	} satisfies DownloadTask & { future: string };
	const alert = {
		acknowledged: false,
		created_at: "2026-10-10T00:00:00Z",
		id: 1,
		kind: "uptime_down",
		message: "Unavailable",
		monitor_id: "monitor-1",
		monitor_name: "Site",
		title: "Site down",
		future: "retained",
	};
	const quest = {
		id: "quest-1",
		title: "Review",
		completion_condition: "Reviewed",
		status: "open",
		created_at: "2026-10-10T00:00:00Z",
		updated_at: "2026-10-10T00:00:00Z",
		future: "retained",
	} satisfies Quest & { future: string };
	const frames = [
		`event: approvals\ndata: ${JSON.stringify({ type: "created", request: { ...approval, status: 42 } })}\n\n`,
		`event: downloads\ndata: ${JSON.stringify({ type: "update", task: { ...task, received_bytes: "bad" } })}\n\n`,
		`event: monitors\ndata: ${JSON.stringify({ ...alert, acknowledged: "bad" })}\n\n`,
		`event: quests\ndata: ${JSON.stringify({ type: "completed", quest, auto: "bad" })}\n\n`,
		`event: approvals\ndata: ${JSON.stringify({ type: "created", request: approval })}\n\n`,
		`event: downloads\ndata: ${JSON.stringify({ type: "snapshot", tasks: [task] })}\n\n`,
		`event: monitors\ndata: ${JSON.stringify(alert)}\n\n`,
		`event: quests\ndata: ${JSON.stringify({ type: "updated", quest })}\n\n`,
	];
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests++;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(frames.join("")));
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const target = {
		url: server.url.toString(),
		token: null,
		userJwt: "fixture-user",
	};
	const controller = new AbortController();
	cleanups.push(() => controller.abort());
	const received: string[] = [];
	const streams = [
		streamApprovalEvents(
			target,
			(event) => {
				received.push("approval");
				expect(event).toEqual({ type: "created", request: approval });
			},
			controller.signal
		),
		streamDownloads(
			target,
			(event) => {
				received.push("download");
				expect(event).toEqual({ type: "snapshot", tasks: [task] });
			},
			controller.signal
		),
		streamMonitorAlerts(
			target,
			(event) => {
				received.push("monitor");
				expect(event).toEqual(alert);
			},
			controller.signal
		),
		streamQuestEvents(
			target,
			(event) => {
				received.push("quest");
				expect(event).toEqual({ type: "updated", quest });
			},
			controller.signal
		),
	];
	await until(() => received.length === 4);
	expect(received).toEqual(["approval", "download", "monitor", "quest"]);
	expect(requests).toBe(1);
	controller.abort();
	await Promise.all(streams);
});

test("a reconnect (not the first open) asks every subscriber to resync", async () => {
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests++;
			const first = requests === 1;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode('event: approvals\ndata: {"n":1}\n\n')
						);
						if (first) {
							controller.close();
						}
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const target = {
		url: server.url.toString(),
		token: "fixture-resync",
		userJwt: null,
	};
	let delivered = 0;
	let resyncs = 0;
	let questResyncs = 0;
	const approvals = subscribeChannel(target, "approvals", () => delivered++, {
		onResync: () => resyncs++,
	});
	const failing = subscribeChannel(target, "approvals", () => undefined, {
		onResync: () => {
			throw new Error("fixture resync failed");
		},
	});
	const quests = subscribeChannel(target, "quests", () => undefined, {
		onResync: () => questResyncs++,
	});
	cleanups.push(approvals, failing, quests);
	await until(() => delivered >= 1);
	expect(resyncs).toBe(0);
	await until(() => resyncs === 1 && delivered === 2);
	// A throwing subscriber neither skips the others nor drops the socket.
	expect(questResyncs).toBe(1);
	expect(requests).toBe(2);
	await Bun.sleep(50);
	expect(requests).toBe(2);
	approvals();
	failing();
	quests();
	expect(resyncs).toBe(1);
});

test("an idle socket is aborted and reopened, then resynced", async () => {
	resetEventStreamIdleTimeoutForTests(100);
	cleanups.push(() => resetEventStreamIdleTimeoutForTests());
	let requests = 0;
	let cancelled = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests++;
			// One keep-alive (Bun flushes headers with the first chunk), then
			// silence: a half-open socket that never errors on its own.
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
					},
					cancel() {
						cancelled++;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	let resyncs = 0;
	const unsubscribe = subscribeChannel(
		{ url: server.url.toString(), token: "fixture-idle", userJwt: null },
		"approvals",
		() => undefined,
		{ onResync: () => resyncs++ }
	);
	cleanups.push(unsubscribe);
	await until(() => requests >= 2 && resyncs >= 1);
	unsubscribe();
	await until(() => cancelled === requests);
});

test("the first open after a failed connect also resyncs", async () => {
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests++;
			if (requests === 1) {
				return new Response("starting", { status: 503 });
			}
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode('event: approvals\ndata: {"n":1}\n\n')
						);
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	let delivered = 0;
	let resyncs = 0;
	const unsubscribe = subscribeChannel(
		{ url: server.url.toString(), token: "fixture-late-open", userJwt: null },
		"approvals",
		() => delivered++,
		{ onResync: () => resyncs++ }
	);
	cleanups.push(unsubscribe);
	// Whatever the subscriber fetched at mount predates the stream, so the gap
	// until this first successful open is refetched.
	await until(() => delivered === 1);
	expect(requests).toBe(2);
	expect(resyncs).toBe(1);
});

test("a request that never gets response headers is aborted and retried", async () => {
	resetEventStreamIdleTimeoutForTests(100);
	cleanups.push(() => resetEventStreamIdleTimeoutForTests());
	let requests = 0;
	let delivered = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests++;
			if (requests === 1) {
				// A dead socket: the request went out, nothing ever comes back.
				return new Promise<Response>(() => undefined);
			}
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode('event: approvals\ndata: {"n":1}\n\n')
						);
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const unsubscribe = subscribeChannel(
		{ url: server.url.toString(), token: "fixture-no-headers", userJwt: null },
		"approvals",
		() => delivered++
	);
	cleanups.push(unsubscribe);
	await until(() => delivered >= 1);
	expect(requests).toBeGreaterThanOrEqual(2);
});

test("accepts CRLF frames and cancels an oversized pending frame", async () => {
	let closed = 0;
	let requests = 0;
	const encoder = new TextEncoder();
	// The oversized chunk is held back until the valid frame has been delivered,
	// so the two never coalesce into one read regardless of transport chunking.
	const { promise: firstDelivered, resolve: markDelivered } =
		Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests += 1;
			if (requests > 1) {
				// Reconnects after the cancel stay silent so the count stays exact.
				return new Response(new ReadableStream({}), {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			let step = 0;
			return new Response(
				new ReadableStream({
					async pull(controller) {
						step += 1;
						if (step === 1) {
							controller.enqueue(
								encoder.encode('event: quests\r\ndata: {"ok":true}\r\n\r\n')
							);
							return;
						}
						if (step === 2) {
							await firstDelivered;
							controller.enqueue(
								encoder.encode(`event: quests\ndata: ${"x".repeat(300_000)}`)
							);
						}
					},
					cancel() {
						closed += 1;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	let delivered = 0;
	const unsubscribe = subscribeChannel(
		{ url: server.url.toString(), token: null, userJwt: "fixture-user" },
		"quests",
		() => {
			delivered += 1;
			markDelivered();
		}
	);
	cleanups.push(unsubscribe);
	await until(() => delivered === 1 && closed >= 1);
	unsubscribe();
	expect(delivered).toBe(1);
}, 10_000);

test("parses CRLF split across chunks and CR-only frames", async () => {
	const encoder = new TextEncoder();
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response(
				new ReadableStream({
					start(controller) {
						// The CR and LF of each terminator arrive in different reads.
						controller.enqueue(encoder.encode("event: quests\r"));
						controller.enqueue(encoder.encode('\ndata: {"n":1}\r'));
						controller.enqueue(encoder.encode("\n\r"));
						controller.enqueue(encoder.encode("\n"));
						// Bare CR line endings are valid SSE too.
						controller.enqueue(
							encoder.encode('event: quests\rdata: {"n":2}\r\r')
						);
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const received: unknown[] = [];
	const unsubscribe = subscribeChannel(
		{ url: server.url.toString(), token: null, userJwt: "fixture-user" },
		"quests",
		(data) => {
			received.push(data);
		}
	);
	cleanups.push(unsubscribe);
	await until(() => received.length >= 2);
	expect(received.slice(0, 2)).toEqual([{ n: 1 }, { n: 2 }]);
});

test("rejects an oversized complete frame before dispatch and cancels the response", async () => {
	let requests = 0;
	let closed = 0;
	const encoder = new TextEncoder();
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests += 1;
			const first = requests === 1;
			return new Response(
				new ReadableStream({
					start(controller) {
						if (first) {
							// A fully terminated frame that is still over the bound.
							controller.enqueue(
								encoder.encode(
									`event: quests\ndata: {"big":"${"x".repeat(300_000)}"}\n\n`
								)
							);
							controller.enqueue(
								encoder.encode('event: quests\ndata: {"after":true}\n\n')
							);
							return;
						}
						controller.enqueue(
							encoder.encode('event: quests\ndata: {"ok":true}\n\n')
						);
					},
					cancel() {
						closed += 1;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const received: unknown[] = [];
	const unsubscribe = subscribeChannel(
		{ url: server.url.toString(), token: null, userJwt: "fixture-user" },
		"quests",
		(data) => {
			received.push(data);
		}
	);
	cleanups.push(unsubscribe);
	await until(() => received.length >= 1 && closed >= 1);
	unsubscribe();
	// Neither the oversized frame nor anything after it on that response is
	// dispatched; the reconnected response delivers normally.
	expect(received).toEqual([{ ok: true }]);
	expect(requests).toBeGreaterThanOrEqual(2);
});
