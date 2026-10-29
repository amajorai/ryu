/**
 * Defence-in-depth for CVE-2026-111497 (Brotli decoder) on Bun fetch/decompress paths.
 * Bun 1.4.4+ ships patched Brotli 1.2.1; keep these guards until all runtimes are upgraded.
 */

const BROTLI_TOKEN = /\bbr\b/i;

function headersDeclareBrotli(headers: Headers): boolean {
	const encoding = headers.get("content-encoding");
	return encoding !== null && BROTLI_TOKEN.test(encoding);
}

export function requestUsesBrotliContentEncoding(request: Request): boolean {
	return headersDeclareBrotli(request.headers);
}

export function responseUsesBrotliContentEncoding(response: Response): boolean {
	return headersDeclareBrotli(response.headers);
}

export function brotliRequestRejectedResponse(): Response {
	return Response.json(
		{ message: "Content-Encoding: br is not accepted" },
		{ status: 415 }
	);
}

export function brotliResponseRejectedResponse(): Response {
	return Response.json(
		{ message: "Refusing Content-Encoding: br response" },
		{ status: 502 }
	);
}

/** Reject before any body read/decode (Fetch, Hono, or Bun.serve). */
export function rejectBrotliEncodedRequestIfNeeded(
	request: Request
): Response | null {
	if (requestUsesBrotliContentEncoding(request)) {
		return brotliRequestRejectedResponse();
	}
	return null;
}

function stripBrotliFromAcceptEncoding(header: string): string | undefined {
	const filtered = header
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0 && !/^br(?:\s|;|$)/iu.test(part));
	if (filtered.length === 0) {
		return undefined;
	}
	return filtered.join(", ");
}

/** What the guard advertises when the caller sent no usable Accept-Encoding. */
const SAFE_ACCEPT_ENCODING = "gzip, deflate";

/**
 * Bun adds `Accept-Encoding: gzip, deflate, br, zstd` itself when a request has
 * none, so the guard must always set one: the caller's value minus `br`, or
 * gzip and deflate when there was none (or only `br`).
 */
function headersWithoutBrotliAccept(headers: Headers | undefined): Headers {
	const next = new Headers(headers);
	const acceptEncoding = next.get("accept-encoding");
	const stripped =
		acceptEncoding === null
			? undefined
			: stripBrotliFromAcceptEncoding(acceptEncoding);
	next.set("accept-encoding", stripped ?? SAFE_ACCEPT_ENCODING);
	return next;
}

export function fetchInitWithoutBrotliAccept(init?: RequestInit): RequestInit {
	const headers = headersWithoutBrotliAccept(
		init?.headers === undefined ? undefined : new Headers(init.headers)
	);
	return { ...init, headers };
}

/** HEAD replies and these statuses carry no body, so nothing is decoded. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function responseHasNoBody(response: Response, method: string): boolean {
	return method === "HEAD" || BODYLESS_STATUSES.has(response.status);
}

/**
 * A server can answer `Content-Encoding: br` whatever was advertised, and Bun
 * would run the vulnerable decoder on it. Refuse such a response before its
 * body is read.
 */
async function rejectBrotliResponse(
	response: Response,
	method: string
): Promise<Response> {
	if (
		!responseHasNoBody(response, method) &&
		responseUsesBrotliContentEncoding(response)
	) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error("Content-Encoding: br responses are not accepted");
	}
	return response;
}

type FetchFn = typeof fetch;

const FETCH_GUARD_FLAG = Symbol.for("ryu.brotliFetchGuard");

export function installBunBrotliFetchGuard(): void {
	if (typeof Bun === "undefined") {
		return;
	}
	if (
		Object.getOwnPropertyDescriptor(globalThis.fetch, FETCH_GUARD_FLAG)
			?.value === true
	) {
		return;
	}
	const original = globalThis.fetch.bind(globalThis);
	const guarded = ((input, init) => {
		let pending: Promise<Response>;
		if (input instanceof Request && init?.headers === undefined) {
			// With no init headers, the request's own headers are what is sent.
			pending = original(
				new Request(input, {
					headers: headersWithoutBrotliAccept(input.headers),
				}),
				init
			);
		} else {
			pending = original(input, fetchInitWithoutBrotliAccept(init));
		}
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		return pending.then((response) => rejectBrotliResponse(response, method));
	}) as FetchFn;
	Object.defineProperty(guarded, FETCH_GUARD_FLAG, { value: true });
	globalThis.fetch = guarded;
}
