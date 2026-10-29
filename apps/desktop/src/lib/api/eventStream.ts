import { z } from "zod";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/eventStream.ts
//
// A single multiplexed SSE connection per node, shared by every feature feed
// (quests, notifications, monitors, approvals, downloads).
//
// Why this exists: the browser caps HTTP/1.1 at 6 connections per host. The app
// mounts ~6 always-on SSE feeds globally (see Layout.tsx), so opening one socket
// each consumed the entire budget and every other fetch (page data, chat) queued
// forever — the "every page loads forever" bug. Core exposes `/api/events/all`,
// a unified stream that tags each event with its channel via the SSE `event:`
// field; here we open that ONE socket per node and fan events out to per-channel
// subscribers. The connection is reference-counted: it opens on the first
// subscriber and closes when the last one leaves, and reconnects with backoff.
// Core sends no snapshot for most channels and drops lagged frames, so every
// re-open tells subscribers to resync (refetch) whatever they may have missed.

import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import { abortableDelay as waitForEventStreamRetry } from "../abortable-delay.ts";

export { abortableDelay as waitForEventStreamRetry } from "../abortable-delay.ts";

import { type ApiTarget, authenticatedFetch } from "./client.ts";

/** The channels Core's `/api/events/all` tags events with (the SSE `event:`). */
export type EventChannel =
	| "activity"
	| "notifications"
	| "quests"
	| "monitors"
	| "approvals"
	| "downloads"
	| "navigation";

/** A per-channel subscriber. `data` is the parsed JSON of that channel's event. */
type ChannelHandler = (data: GatewayJsonValue) => void;

const eventChannelSchema = z.enum([
	"activity",
	"notifications",
	"quests",
	"monitors",
	"approvals",
	"downloads",
	"navigation",
]);

/** Optional per-subscription hooks for the shared connection's lifecycle. */
export interface ChannelSubscriptionOptions {
	/**
	 * Called after the shared connection re-opens following a drop or a failed
	 * connect (not when the very first attempt opens). Events emitted while it
	 * was down are never replayed, so the subscriber should refetch the state its
	 * feed keeps fresh.
	 */
	onResync?: () => void;
}

const EVENT_PREFIX = "event:";
const DATA_PREFIX = "data:";
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
/** 3x Core's 15s SSE keep-alive: no bytes for this long means a dead socket. */
const IDLE_TIMEOUT_MS = 45_000;
let idleTimeoutMs = IDLE_TIMEOUT_MS;

/** One shared connection to a single node's `/api/events/all`. */
interface MuxConnection {
	/**
	 * Whether an earlier attempt ran. Any later open, including the first one to
	 * succeed after a failed connect, may have missed events since the
	 * subscribers' mount-time fetch.
	 */
	attempted: boolean;
	closed: boolean;
	controller: AbortController;
	resync: Map<EventChannel, Set<() => void>>;
	subscribers: Map<EventChannel, Set<ChannelHandler>>;
}

/** One shared connection per node URL and explicit credential scope. */
const connections = new Map<string, MuxConnection>();

/** Parse one SSE frame and dispatch its payload to the channel's subscribers. */
function dispatchFrame(mux: MuxConnection, frame: string): void {
	let channel: EventChannel | null = null;
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(EVENT_PREFIX)) {
			const parsed = eventChannelSchema.safeParse(
				line.slice(EVENT_PREFIX.length).trim()
			);
			channel = parsed.success ? parsed.data : null;
		} else if (line.startsWith(DATA_PREFIX)) {
			dataLines.push(line.slice(DATA_PREFIX.length).trim());
		}
	}
	if (!channel || dataLines.length === 0) {
		// Keep-alive comments and untagged frames carry no payload — ignore them.
		return;
	}
	const handlers = mux.subscribers.get(channel);
	if (!handlers || handlers.size === 0) {
		return;
	}
	let parsed: GatewayJsonValue;
	try {
		parsed = gatewayJsonValueSchema.parse(JSON.parse(dataLines.join("\n")));
	} catch {
		// Ignore malformed frames; the next event self-heals the feed.
		return;
	}
	for (const handler of handlers) {
		handler(parsed);
	}
}

/** Tell every subscriber the connection re-opened and may have missed events. */
function notifyResync(mux: MuxConnection): void {
	for (const callbacks of mux.resync.values()) {
		for (const callback of callbacks) {
			try {
				callback();
			} catch {
				// One failing subscriber must not tear down the shared socket.
			}
		}
	}
}

/** Read the unified stream until it ends, dispatching frames as they arrive. */
async function pump(target: ApiTarget, mux: MuxConnection): Promise<void> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (mux.controller.signal.aborted) {
		return;
	}
	mux.controller.signal.addEventListener("abort", abort, { once: true });
	const resumed = mux.attempted;
	mux.attempted = true;
	// A half-open socket (sleep/wake, remote network loss) never errors on its
	// own; aborting after missed keep-alives hands it to the reconnect loop. Armed
	// before the request too, so a reused dead socket cannot stall the connect.
	let idle = setTimeout(abort, idleTimeoutMs);
	try {
		const resp = await authenticatedFetch(target, "/api/events/all", {
			method: "GET",
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});
		if (!(resp.ok && resp.body)) {
			throw new Error(`event stream failed: ${resp.status}`);
		}
		if (resumed) {
			notifyResync(mux);
		}
		const reader = resp.body.getReader();
		const decoder = new SseFrameDecoder();
		clearTimeout(idle);
		idle = setTimeout(abort, idleTimeoutMs);
		try {
			for (;;) {
				const { done, value } = await reader.read();
				clearTimeout(idle);
				if (done) {
					decoder.finish();
					break;
				}
				idle = setTimeout(abort, idleTimeoutMs);
				for (const frame of decoder.push(value)) {
					dispatchFrame(mux, frame);
				}
			}
		} finally {
			decoder.finish();
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	} finally {
		clearTimeout(idle);
		controller.abort();
		mux.controller.signal.removeEventListener("abort", abort);
	}
}

/** Test-only: shorten (or restore, with no argument) the idle watchdog. */
export function resetEventStreamIdleTimeoutForTests(
	ms: number = IDLE_TIMEOUT_MS
): void {
	idleTimeoutMs = ms;
}

/** Run (and keep reconnecting) the shared connection until it is torn down. */
async function runConnection(
	target: ApiTarget,
	mux: MuxConnection
): Promise<void> {
	let backoff = INITIAL_BACKOFF_MS;
	while (!mux.closed) {
		try {
			await pump(target, mux);
			backoff = INITIAL_BACKOFF_MS; // a clean end resets the backoff
		} catch {
			// Connect/read failed (Core restart, transient drop) — reconnect below.
		}
		if (mux.closed || mux.controller.signal.aborted) {
			break;
		}
		await waitForEventStreamRetry(backoff, mux.controller.signal);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	}
}

/**
 * Subscribe to one channel of a node's unified event stream. Opens the shared
 * connection on the first subscriber and closes it when the last one leaves.
 * Returns an unsubscribe function (idempotent).
 */
export function subscribeChannel(
	target: ApiTarget,
	channel: EventChannel,
	handler: ChannelHandler,
	options?: ChannelSubscriptionOptions
): () => void {
	const key = JSON.stringify([
		target.url,
		target.token,
		target.userJwt ?? null,
	]);
	let mux = connections.get(key);
	if (!mux) {
		mux = {
			subscribers: new Map(),
			resync: new Map(),
			controller: new AbortController(),
			closed: false,
			attempted: false,
		};
		connections.set(key, mux);
		runConnection(target, mux).catch(() => undefined);
	}
	let set = mux.subscribers.get(channel);
	if (!set) {
		set = new Set();
		mux.subscribers.set(channel, set);
	}
	set.add(handler);
	// Wrap so the same callback passed twice still registers (and leaves) once each.
	const onResync = options?.onResync;
	const resync = onResync ? () => onResync() : undefined;
	if (resync) {
		let callbacks = mux.resync.get(channel);
		if (!callbacks) {
			callbacks = new Set();
			mux.resync.set(channel, callbacks);
		}
		callbacks.add(resync);
	}

	let unsubscribed = false;
	return () => {
		if (unsubscribed) {
			return;
		}
		unsubscribed = true;
		const current = connections.get(key);
		if (!current) {
			return;
		}
		current.subscribers.get(channel)?.delete(handler);
		if (resync) {
			current.resync.get(channel)?.delete(resync);
		}
		let remaining = 0;
		for (const handlers of current.subscribers.values()) {
			remaining += handlers.size;
		}
		if (remaining === 0) {
			current.closed = true;
			current.controller.abort();
			connections.delete(key);
		}
	};
}

/**
 * Bridge a legacy `stream*(target, onEvent, signal)` call onto the shared
 * connection: subscribe to `channel`, then stay pending until `signal` aborts
 * (matching the old "await until the stream ends" contract its hook relies on).
 * When no signal is given the subscription lives until the process exits, as the
 * original per-feed fetch did.
 */
export function streamChannel<T>(
	target: ApiTarget,
	channel: EventChannel,
	onEvent: (event: T) => void,
	signal: AbortSignal | undefined,
	schema: z.ZodType<T>,
	options?: ChannelSubscriptionOptions
): Promise<void> {
	if (signal?.aborted) {
		return Promise.resolve();
	}
	const unsubscribe = subscribeChannel(
		target,
		channel,
		(data) => {
			const parsed = schema.safeParse(data);
			if (parsed.success) {
				onEvent(parsed.data);
			}
		},
		options
	);
	return new Promise<void>((resolve) => {
		if (!signal) {
			return; // No signal: keep the subscription open indefinitely.
		}
		if (signal.aborted) {
			unsubscribe();
			resolve();
			return;
		}
		signal.addEventListener(
			"abort",
			() => {
				unsubscribe();
				resolve();
			},
			{ once: true }
		);
	});
}
