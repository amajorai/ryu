// Main-process client for Core's shared theme preference (`/api/preferences`).
//
// The island companion is a separate Electron process and cannot read the
// desktop's `localStorage`, so theme sync rides Core: the desktop writes the
// theme blob under the `theme` preference key, and this service reads it and
// subscribes to Core's SSE change stream. The main process treats the blob as
// an opaque JSON string — all parsing/applying happens in the renderer with
// `@ryu/ui/theme` (which cannot run here because main externalizes workspace
// deps and `@ryu/ui` ships TypeScript source).

import { coreHeaders, loadConfig } from "./config.ts";

/** Preference key for the shared theme blob (matches `@ryu/ui` THEME_PREF_KEY). */
const THEME_KEY = "theme";
/** Timeout for the one-shot theme read. */
const GET_TIMEOUT_MS = 5000;
/** Delay before reconnecting a dropped SSE stream. */
const RECONNECT_MS = 3000;
/** Trailing carriage return left by CRLF SSE line endings. */
const TRAILING_CR = /\r$/;

/** Read the current theme blob (raw JSON), or `null` if unset/unreachable. */
export async function getThemePrefsRaw(): Promise<string | null> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
	try {
		const resp = await fetch(`${coreBaseUrl}/api/preferences/${THEME_KEY}`, {
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

/** Extract the theme value from one SSE `data:` payload, or `null`. */
function themeValueFromFrame(payload: string): string | null {
	const trimmed = payload.trim();
	if (trimmed.length === 0) {
		return null;
	}
	try {
		const ev = JSON.parse(trimmed) as { key?: unknown; value?: unknown };
		if (ev.key === THEME_KEY && typeof ev.value === "string") {
			return ev.value;
		}
	} catch {
		// Malformed frame (or a keep-alive comment): ignore.
	}
	return null;
}

/**
 * Subscribe to live theme changes via Core's `/api/preferences/stream` SSE
 * endpoint. Calls `onValue` with each new raw theme blob. Auto-reconnects on
 * drop. Returns a stop function. Never throws to the caller.
 */
/** Consume whole lines from `buffer`, dispatch theme values, return the remainder. */
function dispatchLines(
	buffer: string,
	onValue: (value: string) => void
): string {
	let rest = buffer;
	let newlineIndex = rest.indexOf("\n");
	while (newlineIndex !== -1) {
		const line = rest.slice(0, newlineIndex).replace(TRAILING_CR, "");
		rest = rest.slice(newlineIndex + 1);
		if (line.startsWith("data:")) {
			const themeValue = themeValueFromFrame(line.slice("data:".length));
			if (themeValue !== null) {
				onValue(themeValue);
			}
		}
		newlineIndex = rest.indexOf("\n");
	}
	return rest;
}

/** Read an SSE body, dispatching theme values until it ends or `isStopped()`. */
async function readThemeStream(
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
		buffer = dispatchLines(buffer, onValue);
	}
}

/**
 * Subscribe to live theme changes via Core's `/api/preferences/stream` SSE
 * endpoint. Calls `onValue` with each new raw theme blob. Auto-reconnects on
 * drop. Returns a stop function. Never throws to the caller.
 */
export function subscribeThemeChanges(
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
				await readThemeStream(resp.body, onValue, () => stopped);
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
