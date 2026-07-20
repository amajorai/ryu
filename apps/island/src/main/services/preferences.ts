// Generic main-process client for Core's key-value preference store. A key-scoped
// version of `services/voice.ts`: one-shot read plus an SSE subscription to
// `/api/preferences/stream` filtered to a single key. Used for the island agent
// routing (`island-agents`) and speak-replies (`island-tts`) prefs the desktop
// writes; the blob stays an opaque JSON string here, parsed by the matching
// `shared/*.ts` (no `@ryu/ui` dep, the main process externalizes workspace deps).

import { coreHeaders, loadConfig } from "./config.ts";

/** Timeout for a one-shot preference read. */
const GET_TIMEOUT_MS = 5000;
/** Delay before reconnecting a dropped SSE stream. */
const RECONNECT_MS = 3000;
/** Trailing carriage return left by CRLF SSE line endings. */
const TRAILING_CR = /\r$/;

/** Write a preference value (raw JSON) by key. Returns success; never throws. */
export async function setPreferenceRaw(
	key: string,
	value: string
): Promise<boolean> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
	try {
		const resp = await fetch(`${coreBaseUrl}/api/preferences/${key}`, {
			method: "PUT",
			headers: coreHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ value }),
			signal: controller.signal,
		});
		return resp.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Read a preference value (raw JSON) by key, or `null` if unset/unreachable. */
export async function getPreferenceRaw(key: string): Promise<string | null> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
	try {
		const resp = await fetch(`${coreBaseUrl}/api/preferences/${key}`, {
			method: "GET",
			headers: coreHeaders(),
			signal: controller.signal,
		});
		if (!resp.ok) {
			return null;
		}
		const data = (await resp.json()) as { value?: unknown };
		return typeof data.value === "string" ? data.value : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Extract the value from one SSE `data:` payload for `key`, or `null`. */
function valueFromFrame(key: string, payload: string): string | null {
	const trimmed = payload.trim();
	if (trimmed.length === 0) {
		return null;
	}
	try {
		const ev = JSON.parse(trimmed) as { key?: unknown; value?: unknown };
		if (ev.key === key && typeof ev.value === "string") {
			return ev.value;
		}
	} catch {
		// Malformed frame (or a keep-alive comment): ignore.
	}
	return null;
}

/** Consume whole lines from `buffer`, dispatch values for `key`, return the remainder. */
function dispatchLines(
	key: string,
	buffer: string,
	onValue: (value: string) => void
): string {
	let rest = buffer;
	let newlineIndex = rest.indexOf("\n");
	while (newlineIndex !== -1) {
		const line = rest.slice(0, newlineIndex).replace(TRAILING_CR, "");
		rest = rest.slice(newlineIndex + 1);
		if (line.startsWith("data:")) {
			const value = valueFromFrame(key, line.slice("data:".length));
			if (value !== null) {
				onValue(value);
			}
		}
		newlineIndex = rest.indexOf("\n");
	}
	return rest;
}

/** Read an SSE body, dispatching values for `key` until it ends or `isStopped()`. */
async function readStream(
	key: string,
	body: ReadableStream<Uint8Array>,
	onValue: (value: string) => void,
	isStopped: () => boolean
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (!isStopped()) {
		const { done, value } = await reader.read();
		if (done) {
			return;
		}
		buffer += decoder.decode(value, { stream: true });
		buffer = dispatchLines(key, buffer, onValue);
	}
}

/**
 * Subscribe to live changes of a single preference `key` via Core's
 * `/api/preferences/stream` SSE endpoint. Calls `onValue` with each new raw blob.
 * Auto-reconnects on drop. Returns a stop function. Never throws to the caller.
 */
export function subscribePreferenceChanges(
	key: string,
	onValue: (value: string) => void
): () => void {
	let stopped = false;
	let controller: AbortController | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	const connect = async (): Promise<void> => {
		if (stopped) {
			return;
		}
		const { coreBaseUrl } = loadConfig();
		controller = new AbortController();
		try {
			const resp = await fetch(`${coreBaseUrl}/api/preferences/stream`, {
				method: "GET",
				headers: coreHeaders({ Accept: "text/event-stream" }),
				signal: controller.signal,
			});
			if (resp.ok && resp.body) {
				await readStream(key, resp.body, onValue, () => stopped);
			}
		} catch {
			// Network/abort error: fall through to the reconnect schedule below.
		}
		if (!stopped) {
			reconnectTimer = setTimeout(start, RECONNECT_MS);
		}
	};

	// connect() never rejects (it catches its own errors); the catch is defensive.
	const start = (): void => {
		connect().catch(() => {
			// Unreachable.
		});
	};

	start();

	return () => {
		stopped = true;
		controller?.abort();
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
		}
	};
}
