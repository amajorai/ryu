// Main-process client for Core's shared island-auto-jump preference.
//
// Mirrors `services/edge-offset.ts`: the desktop writes the auto-jump flag under
// the `island-auto-jump` preference key, and this service reads it (on startup)
// and subscribes to Core's SSE change stream so toggling it in settings starts or
// stops the follow-the-cursor behavior live. The value stays an opaque string
// here; `shared/auto-jump.ts` owns the parsing.

import { AUTO_JUMP_PREF_KEY } from "../../shared/auto-jump.ts";
import { coreHeaders, loadConfig } from "./config.ts";

/** Timeout for the one-shot auto-jump read. */
const GET_TIMEOUT_MS = 5000;
/** Delay before reconnecting a dropped SSE stream. */
const RECONNECT_MS = 3000;
/** Trailing carriage return left by CRLF SSE line endings. */
const TRAILING_CR = /\r$/;

/** Read the current auto-jump value (raw), or `null` if unset/unreachable. */
export async function getAutoJumpRaw(): Promise<string | null> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
	try {
		const resp = await fetch(
			`${coreBaseUrl}/api/preferences/${AUTO_JUMP_PREF_KEY}`,
			{
				method: "GET",
				headers: coreHeaders(),
				signal: controller.signal,
			}
		);
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

/** Extract the auto-jump value from one SSE `data:` payload, or `null`. */
function autoJumpValueFromFrame(payload: string): string | null {
	const trimmed = payload.trim();
	if (trimmed.length === 0) {
		return null;
	}
	try {
		const ev = JSON.parse(trimmed) as { key?: unknown; value?: unknown };
		if (ev.key === AUTO_JUMP_PREF_KEY && typeof ev.value === "string") {
			return ev.value;
		}
	} catch {
		// Malformed frame (or a keep-alive comment): ignore.
	}
	return null;
}

/** Consume whole lines from `buffer`, dispatch values, return the remainder. */
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
			const value = autoJumpValueFromFrame(line.slice("data:".length));
			if (value !== null) {
				onValue(value);
			}
		}
		newlineIndex = rest.indexOf("\n");
	}
	return rest;
}

/** Read an SSE body, dispatching values until it ends or `isStopped()`. */
async function readAutoJumpStream(
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
 * Subscribe to live auto-jump changes via Core's `/api/preferences/stream` SSE
 * endpoint. Calls `onValue` with each new raw value. Auto-reconnects on drop.
 * Returns a stop function. Never throws to the caller.
 */
export function subscribeAutoJumpChanges(
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
				await readAutoJumpStream(resp.body, onValue, () => stopped);
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
