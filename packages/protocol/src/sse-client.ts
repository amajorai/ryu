import type { z } from "zod";

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

const EVENT_PREFIX = "event:";
const DATA_PREFIX = "data:";

/**
 * Maximum wire bytes retained for one SSE event before its terminating blank
 * line. This is deliberately transport-level: endpoint decoders and output
 * limits only run after framing succeeds.
 */
export const MAX_SSE_EVENT_BYTES = 256 * 1024;

/** Raised before an incomplete or complete SSE event can exceed the bound. */
export class SseFrameTooLargeError extends Error {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`sse event exceeds ${maxBytes} bytes`);
		this.name = "SseFrameTooLargeError";
		this.maxBytes = maxBytes;
	}
}

/**
 * Incremental, byte-bounded SSE frame decoder shared by browser clients.
 * It accepts all line endings allowed by the SSE grammar (LF, CRLF, and CR),
 * including a CRLF pair split between chunks. Returned frames use normalized
 * LF separators so endpoint-specific parsers do not need transport branches.
 */
export class SseFrameDecoder {
	private readonly decoder = new TextDecoder();
	private readonly lines: string[] = [];
	private readonly line: number[] = [];
	private retainedBytes = 0;
	private skipLeadingLf = false;

	constructor(readonly maxEventBytes = MAX_SSE_EVENT_BYTES) {
		if (!(Number.isSafeInteger(maxEventBytes) && maxEventBytes > 0)) {
			throw new TypeError("maxEventBytes must be a positive safe integer");
		}
	}

	/** Feed one response-body chunk and return every completed raw SSE frame. */
	push(chunk: Uint8Array): string[] {
		const frames: string[] = [];
		for (const byte of chunk) {
			if (this.skipLeadingLf) {
				this.skipLeadingLf = false;
				if (byte === 0x0a) {
					continue;
				}
			}
			if (byte === 0x0d) {
				this.skipLeadingLf = true;
				this.finishLine(frames);
				continue;
			}
			if (byte === 0x0a) {
				this.finishLine(frames);
				continue;
			}
			this.line.push(byte);
			this.retain(1);
		}
		return frames;
	}

	/** Drop any unterminated event at EOF and release its retained memory. */
	finish(): void {
		this.clear();
	}

	private finishLine(frames: string[]): void {
		if (this.line.length === 0) {
			if (this.lines.length > 0) {
				frames.push(this.lines.join("\n"));
			}
			this.lines.length = 0;
			this.retainedBytes = 0;
			return;
		}

		this.lines.push(this.decoder.decode(Uint8Array.from(this.line)));
		this.line.length = 0;
		// Keep one byte of budget for the normalized line separator retained in
		// the frame. CRLF therefore cannot bypass the limit by changing spelling.
		this.retain(1);
	}

	private retain(bytes: number): void {
		this.retainedBytes += bytes;
		if (this.retainedBytes <= this.maxEventBytes) {
			return;
		}
		this.clear();
		throw new SseFrameTooLargeError(this.maxEventBytes);
	}

	private clear(): void {
		this.line.length = 0;
		this.lines.length = 0;
		this.retainedBytes = 0;
		this.skipLeadingLf = false;
	}
}

/** One parsed SSE frame: its `event:` name (default "message") and JSON `data`. */
export interface SseMessage<T> {
	data: T;
	event: string;
}

/**
 * Thrown by {@link openSse} when the CONNECT fails (non-2xx, or a 2xx with no
 * body). Carries the HTTP `status` so a reconnect loop can tell a transient
 * failure from a permanent refusal — a 409 that will keep being a 409 does not
 * deserve the same retry cadence as a restarting server. The `message` is
 * unchanged from the plain `Error` this replaced.
 */
export class SseConnectError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`sse stream failed: ${status}`);
		this.name = "SseConnectError";
		this.status = status;
	}
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
 * skipped. Ends when the stream closes or `signal` aborts. Throws an
 * {@link SseConnectError} (carrying the HTTP status) on a non-2xx connect so the
 * caller can decide whether — and how fast — to reconnect.
 *
 *   for await (const msg of openSse(url, { token, decode: redemptionEventSchema.parse })) {
 *     handle(msg.data);
 *   }
 */
export interface DecodedOpenSseOptions<T> extends OpenSseOptions {
	/** Decode the endpoint's complete event contract before yielding it. */
	decode: z.ZodType<T>["parse"];
}
export function openSse<T>(
	url: string,
	options: DecodedOpenSseOptions<T>
): AsyncGenerator<SseMessage<T>>;
export function openSse(
	url: string,
	options?: OpenSseOptions
): AsyncGenerator<SseMessage<unknown>>;
export async function* openSse(
	url: string,
	options: OpenSseOptions & { decode?: z.ZodType["parse"] } = {}
): AsyncGenerator<SseMessage<unknown>> {
	const headers = { ...options.headers };
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
		throw new SseConnectError(resp.status);
	}

	const reader = resp.body.getReader();
	const frames = new SseFrameDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				frames.finish();
				break;
			}
			for (const frame of frames.push(value)) {
				const parsed = parseFrame(frame);
				if (parsed) {
					try {
						const data = JSON.parse(parsed.data);
						yield {
							event: parsed.event,
							data: options.decode ? options.decode(data) : data,
						};
					} catch {
						// Ignore a malformed frame; the next event self-heals the feed.
					}
				}
			}
		}
	} finally {
		frames.finish();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/**
 * Callback-style wrapper over {@link openSse}, mirroring the existing per-feature
 * readers (e.g. `streamDesktopNotifications`): invoke `onMessage` for each event,
 * resolve when the stream ends or `signal` aborts. Convenient for surfaces that
 * prefer a callback + reconnect loop over consuming the async generator directly.
 */
export async function readSse<T>(
	url: string,
	onMessage: (message: SseMessage<T>) => void,
	options: DecodedOpenSseOptions<T>
): Promise<void> {
	for await (const message of openSse<T>(url, options)) {
		onMessage(message);
	}
}
