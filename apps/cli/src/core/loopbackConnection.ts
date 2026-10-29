// One HTTP/1.1 connection to a literal loopback address.
//
// The CLI authenticates a plain-HTTP loopback Core with a challenge and must
// then send the node bearer to the SAME process that answered it. `fetch` pools
// and re-dials connections on its own, so a request after a passed challenge
// can land on a new connection to whoever owns the port by then (Core crashed
// or restarted for an update, and another local account bound the port). This
// module owns the socket instead: the identity challenge and the credentialed
// request travel on one TCP connection to one literal address, and a squatter
// cannot take over a connection that is already established.
//
// The client is deliberately small: sequential requests, buffered request
// bodies, `Content-Length` / chunked / close-delimited response bodies, no
// redirects, no compression, no upgrades.

import { connect, type Socket } from "node:net";

/** A single TCP connection to `address:port`, carrying sequential requests. */
export interface LoopbackConnection {
	/** The literal address dialed (`127.0.0.1`, `::1`), never a host name. */
	readonly address: string;
	close(): void;
	/** `false` once either side closed the connection. */
	readonly open: boolean;
	readonly port: number;
	/**
	 * Send `request` on this connection and resolve with the response head.
	 * The previous response body must be read to its end first. With `close`,
	 * the connection is closed once this response body ends.
	 */
	send(
		request: Request,
		options: { close: boolean; signal?: AbortSignal }
	): Promise<Response>;
}

/** Opens a connection to a literal loopback address. */
export type LoopbackConnector = (
	address: string,
	port: number,
	signal: AbortSignal
) => Promise<LoopbackConnection>;

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const HIGH_WATER_BYTES = 1024 * 1024;
const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/u;
const CHUNK_SIZE = /^([0-9a-fA-F]{1,15})(?:;.*)?$/u;
const DIGITS = /^\d{1,15}$/u;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
/** Hop-by-hop or framing headers this client sets itself. */
const MANAGED_REQUEST_HEADERS = new Set([
	"accept-encoding",
	"connection",
	"content-length",
	"expect",
	"host",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/** A malformed response; a `TypeError` like any other `fetch` network error. */
class ProtocolError extends TypeError {
	constructor(message: string) {
		super(`Invalid response from loopback Core: ${message}`);
	}
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** Buffers socket bytes for the response parser, with backpressure. */
class SocketReader {
	private pending: Buffer = Buffer.alloc(0);
	private ended = false;
	private failure: unknown = null;
	private wake: (() => void) | null = null;
	private readonly socket: Socket;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => {
			this.pending =
				this.pending.length === 0
					? chunk
					: Buffer.concat([this.pending, chunk]);
			if (this.pending.length > HIGH_WATER_BYTES) {
				socket.pause();
			}
			this.notify();
		});
		socket.on("end", () => {
			this.ended = true;
			this.notify();
		});
		socket.on("close", () => {
			this.ended = true;
			this.notify();
		});
		socket.on("error", (error) => {
			this.failure = error;
			this.notify();
		});
	}

	fail(reason: unknown): void {
		this.failure ??= reason;
		this.notify();
	}

	private notify(): void {
		const wake = this.wake;
		this.wake = null;
		wake?.();
	}

	/** Wait until more than `have` bytes are buffered; `false` if the peer
	 *  closed first. A failure (socket error, abort) wins over buffered bytes. */
	private async grow(have: number): Promise<boolean> {
		for (;;) {
			if (this.failure !== null) {
				throw this.failure;
			}
			if (this.pending.length > have) {
				return true;
			}
			if (this.ended) {
				return false;
			}
			this.socket.resume();
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}

	private take(length: number): Buffer {
		const taken = this.pending.subarray(0, length);
		this.pending = this.pending.subarray(length);
		if (this.pending.length <= HIGH_WATER_BYTES) {
			this.socket.resume();
		}
		return Buffer.from(taken);
	}

	/** Bytes up to (not including) `delimiter`, which is consumed. */
	async until(delimiter: Buffer, limit: number): Promise<Buffer> {
		for (;;) {
			const index = this.pending.indexOf(delimiter);
			if (index !== -1) {
				const found = this.take(index);
				this.take(delimiter.length);
				return found;
			}
			if (this.pending.length > limit) {
				throw new ProtocolError("header section too large");
			}
			if (!(await this.grow(this.pending.length))) {
				throw new ProtocolError("connection closed mid-response");
			}
		}
	}

	/** Up to `max` bytes, or `null` once the peer closed. */
	async upTo(max: number): Promise<Buffer | null> {
		if (!(await this.grow(0))) {
			return null;
		}
		return this.take(Math.min(max, this.pending.length));
	}
}

type BodyFraming =
	| { kind: "none" }
	| { kind: "length"; remaining: number }
	| { kind: "chunked" }
	| { kind: "close" };

function parseHead(raw: Buffer): {
	headers: Headers;
	status: number;
	statusText: string;
} {
	const lines = raw.toString("latin1").split("\r\n");
	const match = STATUS_LINE.exec(lines[0] ?? "");
	if (!match) {
		throw new ProtocolError("bad status line");
	}
	const headers = new Headers();
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(":");
		if (colon <= 0 || line.startsWith(" ") || line.startsWith("\t")) {
			throw new ProtocolError("bad header line");
		}
		headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	return {
		headers,
		status: Number(match[1]),
		statusText: match[2] ?? "",
	};
}

function bodyFraming(
	method: string,
	status: number,
	headers: Headers
): BodyFraming {
	if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
		return { kind: "none" };
	}
	const transfer = headers.get("transfer-encoding");
	if (transfer !== null) {
		if (transfer.trim().toLowerCase() !== "chunked") {
			throw new ProtocolError("unsupported transfer-encoding");
		}
		return { kind: "chunked" };
	}
	const length = headers.get("content-length");
	if (length !== null) {
		const values = new Set(length.split(",").map((value) => value.trim()));
		const [only] = values;
		if (values.size !== 1 || only === undefined || !DIGITS.test(only)) {
			throw new ProtocolError("bad content-length");
		}
		return { kind: "length", remaining: Number(only) };
	}
	return { kind: "close" };
}

function serializeHead(
	request: Request,
	url: URL,
	bodyLength: number | null,
	close: boolean
): Buffer {
	const lines = [
		`${request.method} ${url.pathname}${url.search} HTTP/1.1`,
		`Host: ${url.host}`,
		`Connection: ${close ? "close" : "keep-alive"}`,
		"Accept-Encoding: identity",
	];
	if (bodyLength !== null) {
		lines.push(`Content-Length: ${bodyLength}`);
	}
	request.headers.forEach((value, name) => {
		if (!MANAGED_REQUEST_HEADERS.has(name.toLowerCase())) {
			lines.push(`${name}: ${value}`);
		}
	});
	return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

class SocketConnection implements LoopbackConnection {
	readonly address: string;
	readonly port: number;
	private readonly socket: Socket;
	private readonly reader: SocketReader;
	private busy = false;
	private closed = false;

	constructor(socket: Socket, address: string, port: number) {
		this.socket = socket;
		this.address = address;
		this.port = port;
		this.reader = new SocketReader(socket);
		socket.on("close", () => {
			this.closed = true;
		});
	}

	get open(): boolean {
		return !this.closed;
	}

	close(): void {
		this.closed = true;
		this.socket.destroy();
	}

	async send(
		request: Request,
		options: { close: boolean; signal?: AbortSignal }
	): Promise<Response> {
		if (this.busy || this.closed) {
			throw new TypeError("Loopback Core connection is not available");
		}
		this.busy = true;
		const signal = options.signal;
		if (signal?.aborted) {
			this.close();
			throw abortReason(signal);
		}
		const onAbort = () => {
			if (signal) {
				this.reader.fail(abortReason(signal));
			}
			this.close();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const release = () => signal?.removeEventListener("abort", onAbort);
		try {
			const url = new URL(request.url);
			const method = request.method.toUpperCase();
			const body =
				METHODS_WITHOUT_BODY.has(method) || request.body === null
					? null
					: Buffer.from(await request.arrayBuffer());
			const bodyLength = body?.length ?? (method === "POST" ? 0 : null);
			this.socket.write(serializeHead(request, url, bodyLength, options.close));
			if (body && body.length > 0) {
				this.socket.write(body);
			}
			let head = parseHead(await this.reader.until(HEAD_END, MAX_HEAD_BYTES));
			while (head.status >= 100 && head.status < 200) {
				if (head.status === 101) {
					throw new ProtocolError("unexpected protocol upgrade");
				}
				head = parseHead(await this.reader.until(HEAD_END, MAX_HEAD_BYTES));
			}
			const framing = bodyFraming(method, head.status, head.headers);
			const closeAfter =
				options.close ||
				framing.kind === "close" ||
				head.headers.get("connection")?.toLowerCase().includes("close") ===
					true;
			const finish = () => {
				release();
				this.busy = false;
				if (closeAfter) {
					this.close();
				}
			};
			if (framing.kind === "none") {
				finish();
				return new Response(null, head);
			}
			return new Response(this.bodyStream(framing, finish, release), head);
		} catch (error) {
			release();
			this.close();
			throw signal?.aborted ? abortReason(signal) : error;
		}
	}

	private bodyStream(
		framing: Exclude<BodyFraming, { kind: "none" }>,
		finish: () => void,
		release: () => void
	): ReadableStream<Uint8Array> {
		const reader = this.reader;
		let remaining = framing.kind === "length" ? framing.remaining : 0;
		let chunkLeft = 0;
		let needChunkHeader = true;
		const fail = (
			controller: ReadableStreamDefaultController,
			error: unknown
		) => {
			release();
			this.close();
			controller.error(error);
		};
		const done = (controller: ReadableStreamDefaultController) => {
			finish();
			controller.close();
		};
		const pullLength = async (controller: ReadableStreamDefaultController) => {
			if (remaining === 0) {
				done(controller);
				return;
			}
			const bytes = await reader.upTo(Math.min(remaining, READ_CHUNK_BYTES));
			if (bytes === null) {
				throw new ProtocolError("connection closed before the body ended");
			}
			remaining -= bytes.length;
			controller.enqueue(new Uint8Array(bytes));
			if (remaining === 0) {
				done(controller);
			}
		};
		const pullChunked = async (controller: ReadableStreamDefaultController) => {
			if (needChunkHeader) {
				const line = (await reader.until(CRLF, MAX_LINE_BYTES)).toString(
					"latin1"
				);
				const match = CHUNK_SIZE.exec(line.trim());
				if (!match?.[1]) {
					throw new ProtocolError("bad chunk size");
				}
				chunkLeft = Number.parseInt(match[1], 16);
				needChunkHeader = false;
				if (chunkLeft === 0) {
					// Trailer section: header lines up to an empty line.
					while ((await reader.until(CRLF, MAX_LINE_BYTES)).length > 0) {
						// Trailers are ignored.
					}
					done(controller);
					return;
				}
			}
			const bytes = await reader.upTo(Math.min(chunkLeft, READ_CHUNK_BYTES));
			if (bytes === null) {
				throw new ProtocolError("connection closed before the body ended");
			}
			chunkLeft -= bytes.length;
			controller.enqueue(new Uint8Array(bytes));
			if (chunkLeft === 0) {
				if ((await reader.until(CRLF, MAX_LINE_BYTES)).length > 0) {
					throw new ProtocolError("bad chunk terminator");
				}
				needChunkHeader = true;
			}
		};
		const pullClose = async (controller: ReadableStreamDefaultController) => {
			const bytes = await reader.upTo(READ_CHUNK_BYTES);
			if (bytes === null) {
				done(controller);
				return;
			}
			controller.enqueue(new Uint8Array(bytes));
		};
		const pullers = {
			chunked: pullChunked,
			close: pullClose,
			length: pullLength,
		} as const;
		const pull = pullers[framing.kind];
		return new ReadableStream<Uint8Array>({
			cancel: () => {
				release();
				this.close();
			},
			pull: async (controller) => {
				try {
					await pull(controller);
				} catch (error) {
					fail(controller, error);
				}
			},
		});
	}
}

/** Open a TCP connection to the literal `address:port`. */
export const dialLoopback: LoopbackConnector = (address, port, signal) =>
	new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortReason(signal));
			return;
		}
		const socket = connect({ host: address, noDelay: true, port });
		const onAbort = () => {
			socket.destroy();
			reject(abortReason(signal));
		};
		const onError = (error: Error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		socket.once("error", onError);
		socket.once("connect", () => {
			signal.removeEventListener("abort", onAbort);
			socket.off("error", onError);
			resolve(new SocketConnection(socket, address, port));
		});
	});
