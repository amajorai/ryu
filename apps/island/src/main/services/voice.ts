// Main-process client for Core's shared voice-input preference.
//
// Mirrors `services/appearance.ts`: the desktop writes the voice-input blob under
// the `voice-input` preference key, and this service reads it (on startup) and
// subscribes to Core's SSE change stream so a settings change re-registers the
// push-to-talk shortcut + swaps the transcription engine live. The blob stays an
// opaque JSON string here; `shared/voice.ts` owns the parsing (no `@ryu/ui` dep,
// because the main process externalizes workspace deps).

import { VOICE_PREF_KEY } from "../../shared/voice.ts";
import { coreHeaders, loadConfig } from "./config.ts";

/** Timeout for the one-shot voice-pref read. */
const GET_TIMEOUT_MS = 5000;
/** Delay before reconnecting a dropped SSE stream. */
const RECONNECT_MS = 3000;
/** Trailing carriage return left by CRLF SSE line endings. */
const TRAILING_CR = /\r$/;

/** Read the current voice-input blob (raw JSON), or `null` if unset/unreachable. */
export async function getVoicePrefsRaw(): Promise<string | null> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
	try {
		const resp = await fetch(
			`${coreBaseUrl}/api/preferences/${VOICE_PREF_KEY}`,
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

/** Extract the voice value from one SSE `data:` payload, or `null`. */
function voiceValueFromFrame(payload: string): string | null {
	const trimmed = payload.trim();
	if (trimmed.length === 0) {
		return null;
	}
	try {
		const ev = JSON.parse(trimmed) as { key?: unknown; value?: unknown };
		if (ev.key === VOICE_PREF_KEY && typeof ev.value === "string") {
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
			const value = voiceValueFromFrame(line.slice("data:".length));
			if (value !== null) {
				onValue(value);
			}
		}
		newlineIndex = rest.indexOf("\n");
	}
	return rest;
}

/** Read an SSE body, dispatching values until it ends or `isStopped()`. */
async function readVoiceStream(
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
 * Subscribe to live voice-input changes via Core's `/api/preferences/stream` SSE
 * endpoint. Calls `onValue` with each new raw blob. Auto-reconnects on drop.
 * Returns a stop function. Never throws to the caller.
 */
export function subscribeVoiceChanges(
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
				await readVoiceStream(resp.body, onValue, () => stopped);
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
