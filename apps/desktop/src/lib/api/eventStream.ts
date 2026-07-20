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

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

/** The channels Core's `/api/events/all` tags events with (the SSE `event:`). */
export type EventChannel =
	| "notifications"
	| "quests"
	| "monitors"
	| "approvals"
	| "downloads";

/** A per-channel subscriber. `data` is the parsed JSON of that channel's event. */
type ChannelHandler = (data: unknown) => void;

const FRAME_SEP = "\n\n";
const EVENT_PREFIX = "event:";
const DATA_PREFIX = "data:";
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/** One shared connection to a single node's `/api/events/all`. */
interface MuxConnection {
	closed: boolean;
	controller: AbortController;
	subscribers: Map<EventChannel, Set<ChannelHandler>>;
}

/** Shared connections keyed by node base URL (one socket per host). */
const connections = new Map<string, MuxConnection>();

/** Pause that rejects early when the connection is torn down. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}

/** Parse one SSE frame and dispatch its payload to the channel's subscribers. */
function dispatchFrame(mux: MuxConnection, frame: string): void {
	let channel: EventChannel | null = null;
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(EVENT_PREFIX)) {
			channel = line.slice(EVENT_PREFIX.length).trim() as EventChannel;
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
	let parsed: unknown;
	try {
		parsed = JSON.parse(dataLines.join("\n"));
	} catch {
		// Ignore malformed frames; the next event self-heals the feed.
		return;
	}
	for (const handler of handlers) {
		handler(parsed);
	}
}

/** Read the unified stream until it ends, dispatching frames as they arrive. */
async function pump(target: ApiTarget, mux: MuxConnection): Promise<void> {
	const resp = await fetch(apiUrl(target, "/api/events/all"), {
		method: "GET",
		headers: makeHeaders(target.token),
		signal: mux.controller.signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`event stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf(FRAME_SEP);
		while (sep !== -1) {
			dispatchFrame(mux, buffer.slice(0, sep));
			buffer = buffer.slice(sep + FRAME_SEP.length);
			sep = buffer.indexOf(FRAME_SEP);
		}
	}
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
		await delay(backoff, mux.controller.signal);
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
	handler: ChannelHandler
): () => void {
	const key = target.url;
	let mux = connections.get(key);
	if (!mux) {
		mux = {
			subscribers: new Map(),
			controller: new AbortController(),
			closed: false,
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
	signal?: AbortSignal
): Promise<void> {
	const unsubscribe = subscribeChannel(target, channel, (data) => {
		onEvent(data as T);
	});
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
