// packages/protocol/src/sse-client.ts
//
// Shared client reader for the cloud API's SSE endpoints (the streams the Hono
// `sseStreamHandler` in @ryu/api exposes). Lives in @ryuhq/protocol because both
// the web app (apps/web) and the desktop app (apps/desktop) depend on this
// package and it is intentionally framework-free (no React, no Tauri, no DOM
// specifics) — a surface layers its own hook/store on top.
//
// Transport follows the repo convention (see apps/desktop/src/lib/api/
// eventStream.ts and packages/core-client/src/events.ts): SSE is consumed with
// `fetch` + a `ReadableStream` reader, NOT `EventSource`, so the caller can send
// a bearer token as an `Authorization` header (EventSource cannot set headers).
// Web callers that authenticate with a session cookie instead pass
// `credentials: "include"`.

const FRAME_SEP = "\n\n";
const EVENT_PREFIX = "event:";
const DATA_PREFIX = "data:";

/** One parsed SSE frame: its `event:` name (default "message") and JSON `data`. */
export interface SseMessage<T> {
	data: T;
	event: string;
}

export interface OpenSseOptions {
	/** Cookie policy for browser callers using session auth (e.g. "include"). */
	credentials?: RequestInit["credentials"];
	/** Extra request headers, merged over the defaults. */
	headers?: Record<string, string>;
	/** Aborts the request and ends iteration when triggered. */
	signal?: AbortSignal;
	/** Bearer token sent as `Authorization: Bearer <token>` when present. */
	token?: string | null;
}

/** Parse the `event:`/`data:` lines of one raw SSE frame. */
function parseFrame(frame: string): { event: string; data: string } | null {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(":")) {
			// Comment line (e.g. keepalive) — carries no payload.
			continue;
		}
		if (line.startsWith(EVENT_PREFIX)) {
			event = line.slice(EVENT_PREFIX.length).trim();
		} else if (line.startsWith(DATA_PREFIX)) {
			dataLines.push(line.slice(DATA_PREFIX.length).trim());
		}
	}
	if (dataLines.length === 0) {
		return null;
	}
	return { event, data: dataLines.join("\n") };
}

/**
 * Open an SSE stream and async-iterate its parsed events. Yields one
 * {@link SseMessage} per frame; keepalive comments and payload-less frames are
 * skipped. Ends when the stream closes or `signal` aborts. Throws on a non-2xx
 * connect so the caller can decide whether to reconnect.
 *
 *   for await (const msg of openSse<RedemptionEvent>(url, { token })) {
 *     handle(msg.data);
 *   }
 */
export async function* openSse<T = unknown>(
	url: string,
	options: OpenSseOptions = {}
): AsyncGenerator<SseMessage<T>> {
	const headers: Record<string, string> = { ...options.headers };
	if (options.token) {
		headers.Authorization = `Bearer ${options.token}`;
	}

	const resp = await fetch(url, {
		method: "GET",
		headers,
		credentials: options.credentials,
		signal: options.signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`sse stream failed: ${resp.status}`);
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
			const parsed = parseFrame(buffer.slice(0, sep));
			buffer = buffer.slice(sep + FRAME_SEP.length);
			if (parsed) {
				try {
					yield { event: parsed.event, data: JSON.parse(parsed.data) as T };
				} catch {
					// Ignore a malformed frame; the next event self-heals the feed.
				}
			}
			sep = buffer.indexOf(FRAME_SEP);
		}
	}
}

/**
 * Callback-style wrapper over {@link openSse}, mirroring the existing per-feature
 * readers (e.g. `streamDesktopNotifications`): invoke `onMessage` for each event,
 * resolve when the stream ends or `signal` aborts. Convenient for surfaces that
 * prefer a callback + reconnect loop over consuming the async generator directly.
 */
export async function readSse<T = unknown>(
	url: string,
	onMessage: (message: SseMessage<T>) => void,
	options: OpenSseOptions = {}
): Promise<void> {
	for await (const message of openSse<T>(url, options)) {
		onMessage(message);
	}
}
