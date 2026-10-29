import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { buildAssistantSystemPrompt, findRelevantDocs } from "./docs.ts";
import {
	guestChatInputSchema,
	MAX_GUEST_QUESTION_CHARS,
} from "./guest-contract.ts";

/**
 * Same-origin guest chat for the public assistant widget.
 *
 * Every turn goes through the hosted Ryu Gateway's OpenAI-compatible endpoint
 * with an `rgw_` key of a Ryu-internal organization, so the platform safety
 * floor, audit and that org's budget apply. Each turn carries a hashed
 * per-visitor id for the Gateway; it becomes the Gateway subject only once the
 * control plane flags the key as serving end users, which it does not emit
 * yet. There is no direct provider path and no third-party free tier: when the Gateway URL or
 * key is missing the route fails closed with a friendly notice.
 *
 * Abuse controls, and what they depend on:
 * - The Origin check only stops other sites' browsers from calling this route.
 *   A script can send any Origin, so it is not an abuse control.
 * - The per-visitor limiter keys on one client address header that the
 *   deployment names explicitly, because only the edge in front of the site
 *   can make such a header trustworthy (for example Cloudflare overwriting
 *   `cf-connecting-ip`). If the origin is reachable without that edge, the
 *   header is caller-controlled; that is an edge configuration requirement.
 *   With no header named, production refuses guest chat rather than pooling
 *   every visitor into one shared bucket.
 * - Limits are per process. The process-wide cap, the Gateway org budget and
 *   the platform floor are the backstops across instances.
 */

const DEFAULT_GUEST_MODEL = "openrouter/free";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_UPSTREAM_BYTES = 256 * 1024;
const MAX_ANSWER_CHARS = 12_000;
const REQUEST_TIMEOUT_MS = 60_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const GLOBAL_RATE_LIMIT_MAX_REQUESTS = 300;
const MAX_RATE_LIMIT_KEYS = 5000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SUPPORTED_CLIENT_IP_HEADERS = new Set([
	"cf-connecting-ip",
	"fly-client-ip",
	"true-client-ip",
	"x-forwarded-for",
	"x-real-ip",
]);
const END_USER_DOMAIN = "ryu.guest-chat.end-user.v1";

export const GUEST_UNAVAILABLE_MESSAGE =
	"Guest chat is temporarily unavailable. Try the Browser runtime, or try again later.";
const GUEST_REFUSED_MESSAGE =
	"Guest chat can't help with that request. It only answers questions about Ryu.";
const GUEST_PAUSED_MESSAGE = "Guest chat is paused for this connection.";
const GUEST_BUSY_MESSAGE =
	"Guest chat is busy right now. Try again in a few minutes.";
const GUEST_STOPPED_MESSAGE =
	"Guest chat stopped before finishing this answer.";

type GuestFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GuestChatConfig {
	/** Exact browser origins allowed to post, or null to use the request host. */
	allowedOrigins: string[] | null;
	/** The edge-set client address header to key limits on, or null. */
	clientIpHeader: string | null;
	/** An `rgw_` hosted Gateway key for the Ryu-internal guest chat org. */
	gatewayKey: string;
	/** Gateway base URL without `/v1`. */
	gatewayUrl: string;
	model: string;
	production: boolean;
}

function gatewayBaseUrl(raw: string | undefined): string | null {
	const text = raw?.trim();
	if (!text) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	const secure =
		url.protocol === "https:" ||
		(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
	if (!secure || url.username || url.password || url.search || url.hash) {
		return null;
	}
	return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

function originList(raw: string | undefined): string[] | null {
	const origins: string[] = [];
	for (const entry of (raw ?? "").split(",")) {
		try {
			const text = entry.trim();
			if (text) {
				origins.push(new URL(text).origin);
			}
		} catch {
			// Ignore an entry that is not a URL; it can never match an Origin.
		}
	}
	return origins.length > 0 ? origins : null;
}

/**
 * Reads the guest chat settings at call time. Null unless the Gateway URL is
 * HTTPS (or loopback HTTP) and the key is an `rgw_` key, so a provider key can
 * never be configured here by mistake. Also null in production when no
 * supported client address header is named, because every turn would then be
 * refused; GET and POST share this answer, so the widget never offers a lane
 * that cannot answer.
 */
export function guestChatConfig(
	env: NodeJS.ProcessEnv = process.env
): GuestChatConfig | null {
	const gatewayUrl = gatewayBaseUrl(env.RYU_GUEST_CHAT_GATEWAY_URL);
	const gatewayKey = env.RYU_GUEST_CHAT_GATEWAY_KEY?.trim();
	if (!(gatewayUrl && gatewayKey?.startsWith("rgw_"))) {
		return null;
	}
	const header = env.RYU_GUEST_CHAT_CLIENT_IP_HEADER?.trim().toLowerCase();
	const clientIpHeader =
		header && SUPPORTED_CLIENT_IP_HEADERS.has(header) ? header : null;
	const production = env.NODE_ENV === "production";
	if (production && !clientIpHeader) {
		return null;
	}
	return {
		allowedOrigins: originList(env.RYU_GUEST_CHAT_ALLOWED_ORIGINS),
		clientIpHeader,
		gatewayKey,
		gatewayUrl,
		model: env.RYU_GUEST_CHAT_MODEL?.trim() || DEFAULT_GUEST_MODEL,
		production,
	};
}

const responseJsonSchema = z.json();

function json(
	body: Parameters<typeof responseJsonSchema.parse>[0],
	status = 200,
	headers: HeadersInit = {}
): Response {
	return new Response(JSON.stringify(responseJsonSchema.parse(body)), {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "application/json",
			...headers,
		},
	});
}

function failure(
	message: string,
	status: number,
	headers: HeadersInit = {}
): Response {
	return json({ error: { message } }, status, headers);
}

function expandIpv6(address: string): bigint | null {
	const [head = "", tail, extra] = address.split("::");
	if (extra !== undefined) {
		return null;
	}
	const headParts = head ? head.split(":") : [];
	const tailParts = tail ? tail.split(":") : [];
	const missing = 8 - headParts.length - tailParts.length;
	if (missing < 0 || (tail === undefined && missing !== 0)) {
		return null;
	}
	const parts = [
		...headParts,
		...Array.from({ length: tail === undefined ? 0 : missing }, () => "0"),
		...tailParts,
	];
	let value = 0n;
	for (const part of parts) {
		value = (value << 16n) + BigInt(Number.parseInt(part || "0", 16));
	}
	return value;
}

/**
 * One IP literal to a limiter bucket, or null. IPv4-mapped IPv6 folds into
 * IPv4, and IPv6 is keyed by its /64 so rotating addresses inside one
 * allocation does not reset the limit.
 */
export function guestBucketKey(raw: string | undefined): string | null {
	const address =
		raw
			?.trim()
			.replace(/^\[|\]$/gu, "")
			.split("%", 1)[0] ?? "";
	if (address.length > 64) {
		return null;
	}
	const family = isIP(address);
	if (family === 4) {
		return `v4:${address}`;
	}
	if (family !== 6) {
		return null;
	}
	const lower = address.toLowerCase();
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(lower);
	if (mapped?.[1]) {
		return `v4:${mapped[1]}`;
	}
	if (lower.includes(".")) {
		return `v6:${lower}`;
	}
	const value = expandIpv6(lower);
	return value === null ? null : `v6:${(value >> 64n).toString(16)}/64`;
}

/**
 * The visitor's limiter bucket, or null to refuse. Only the header the
 * deployment named is read. For `x-forwarded-for` the right-most hop (added
 * by the nearest proxy) is used; other headers must hold exactly one address.
 */
export function guestClientBucket(
	request: Request,
	config: Pick<GuestChatConfig, "clientIpHeader" | "production">
): string | null {
	if (!config.clientIpHeader) {
		return config.production ? null : "local";
	}
	const hops = (request.headers.get(config.clientIpHeader) ?? "")
		.split(",")
		.map((hop) => hop.trim())
		.filter(Boolean);
	const candidate =
		config.clientIpHeader === "x-forwarded-for"
			? hops.at(-1)
			: hops.length === 1
				? hops[0]
				: undefined;
	return guestBucketKey(candidate);
}

function requestOrigin(request: Request): string | null {
	const host =
		request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
		request.headers.get("host")?.trim();
	if (!host) {
		return new URL(request.url).origin;
	}
	const forwardedProtocol = request.headers
		.get("x-forwarded-proto")
		?.split(",")[0]
		.trim();
	const protocol =
		forwardedProtocol || new URL(request.url).protocol.replace(/:$/, "");
	try {
		return new URL(`${protocol}://${host}`).origin;
	} catch {
		return null;
	}
}

/**
 * Browser cross-site guard. With an explicit allowlist the Origin must be one
 * of those origins; without one it must match the site's own public host.
 */
function originAllowed(
	request: Request,
	allowedOrigins: string[] | null
): boolean {
	const origin = request.headers.get("origin");
	if (!origin || request.headers.get("sec-fetch-site") === "cross-site") {
		return false;
	}
	return allowedOrigins
		? allowedOrigins.includes(origin)
		: origin === requestOrigin(request);
}

const visitorHits = new Map<string, number[]>();
let globalWindow = { count: 0, startedAt: 0 };

/** Test hook: forget every in-process guest chat limit. */
export function resetGuestChatLimits(): void {
	visitorHits.clear();
	globalWindow = { count: 0, startedAt: 0 };
}

function visitorLimited(key: string, now: number): boolean {
	const cutoff = now - RATE_LIMIT_WINDOW_MS;
	const hits = (visitorHits.get(key) ?? []).filter((at) => at > cutoff);
	hits.push(now);
	// Re-insert so map order is least recently used first.
	visitorHits.delete(key);
	visitorHits.set(key, hits);
	if (visitorHits.size > MAX_RATE_LIMIT_KEYS) {
		for (const [entryKey, entryHits] of visitorHits) {
			if (!entryHits.some((at) => at > cutoff)) {
				visitorHits.delete(entryKey);
			}
		}
		for (const entryKey of visitorHits.keys()) {
			if (visitorHits.size <= MAX_RATE_LIMIT_KEYS) {
				break;
			}
			visitorHits.delete(entryKey);
		}
	}
	return hits.length > RATE_LIMIT_MAX_REQUESTS;
}

function globalLimited(now: number): boolean {
	if (now - globalWindow.startedAt >= RATE_LIMIT_WINDOW_MS) {
		globalWindow = { count: 0, startedAt: now };
	}
	globalWindow.count += 1;
	return globalWindow.count > GLOBAL_RATE_LIMIT_MAX_REQUESTS;
}

/**
 * The Gateway end-user id for one visitor bucket: a keyed hash, so the raw
 * address never leaves this process and cannot be recovered by enumerating
 * the IPv4 space. The Gateway hashes it again per organization.
 */
export function guestEndUserId(bucket: string, gatewayKey: string): string {
	const digest = createHmac("sha256", gatewayKey)
		.update(`${END_USER_DOMAIN}\u0000${bucket}`)
		.digest("hex");
	return `gc1.${digest.slice(0, 32)}`;
}

async function readBoundedText(request: Request): Promise<string | null> {
	const contentLength = request.headers.get("content-length");
	if (
		contentLength &&
		(!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)
	) {
		return null;
	}
	if (!request.body) {
		return "";
	}
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return text + decoder.decode();
			}
			bytes += value.byteLength;
			if (bytes > MAX_BODY_BYTES) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

const gatewayErrorSchema = z.object({
	error: z.object({
		code: z.string().optional().catch(undefined),
		type: z.string().optional().catch(undefined),
	}),
});
const UNAVAILABLE_POLICY_CODES = new Set([
	"org_suspended",
	"user_banned",
	"key_suspended_abuse",
	"principal_blocked",
]);
/**
 * Refusals aimed at one visitor. The Gateway does not emit these yet, so today
 * a block lands on the shared credential; this mapping is forward-compatible.
 */
const VISITOR_POLICY_CODES = new Set([
	"end_user_blocked",
	"end_user_suspended_abuse",
]);

/**
 * A fixed reply per Gateway refusal. The Gateway's message, code and safety
 * categories are never passed on to the visitor.
 */
async function gatewayRefusal(response: Response): Promise<Response> {
	if (response.status === 429) {
		await response.body?.cancel().catch(() => undefined);
		const retryAfter = response.headers.get("retry-after");
		return failure(
			GUEST_BUSY_MESSAGE,
			429,
			retryAfter && /^\d{1,5}$/u.test(retryAfter)
				? { "Retry-After": retryAfter }
				: {}
		);
	}
	if (response.status !== 403) {
		await response.body?.cancel().catch(() => undefined);
		return failure(GUEST_UNAVAILABLE_MESSAGE, 503);
	}
	let body: unknown = null;
	try {
		const text = await response.text();
		body = text.length <= MAX_UPSTREAM_BYTES ? JSON.parse(text) : null;
	} catch {
		body = null;
	}
	const error = gatewayErrorSchema.safeParse(body).data?.error;
	if (error?.code && UNAVAILABLE_POLICY_CODES.has(error.code)) {
		return failure(GUEST_UNAVAILABLE_MESSAGE, 503);
	}
	if (error?.code && VISITOR_POLICY_CODES.has(error.code)) {
		return failure(GUEST_PAUSED_MESSAGE, 403);
	}
	return error?.type === "policy_violation"
		? failure(GUEST_REFUSED_MESSAGE, 403)
		: failure(GUEST_UNAVAILABLE_MESSAGE, 503);
}

const frameSchema = z.object({
	error: z.unknown().optional(),
	choices: z
		.array(
			z
				.object({
					delta: z
						.object({ content: z.string().optional().catch(undefined) })
						.optional()
						.catch(undefined),
				})
				.optional()
				.catch(undefined)
		)
		.optional()
		.catch(undefined),
});

type FrameResult =
	| { kind: "done" }
	| { kind: "error" }
	| { kind: "text"; text: string }
	| { kind: "skip" };

function readFrame(data: string): FrameResult {
	if (data === "[DONE]") {
		return { kind: "done" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return { kind: "skip" };
	}
	const frame = frameSchema.safeParse(parsed);
	if (!frame.success) {
		return { kind: "skip" };
	}
	if (frame.data.error !== undefined && frame.data.error !== null) {
		return { kind: "error" };
	}
	const text = frame.data.choices?.[0]?.delta?.content;
	return text ? { kind: "text", text } : { kind: "skip" };
}

function sse(payload: string): Uint8Array {
	return new TextEncoder().encode(`data: ${payload}\n\n`);
}

/**
 * Re-emits only text deltas and the end marker from the Gateway stream. An
 * error frame (for example a mid-stream floor block) becomes one fixed
 * message, so no Gateway field reaches the browser. Bytes and answer length
 * are bounded.
 */
function relayGuestStream(upstream: ReadableStream<Uint8Array>) {
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let bytes = 0;
	let chars = 0;
	let finished = false;

	const finish = async (
		controller: ReadableStreamDefaultController<Uint8Array>,
		payload: string | null
	) => {
		finished = true;
		if (payload) {
			controller.enqueue(sse(payload));
		}
		controller.enqueue(sse("[DONE]"));
		controller.close();
		await reader.cancel().catch(() => undefined);
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (!finished) {
				const boundary = buffer.indexOf("\n\n");
				if (boundary !== -1) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const data = frame
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice("data:".length).trim())
						.join("\n");
					if (!data) {
						continue;
					}
					const result = readFrame(data);
					if (result.kind === "done") {
						await finish(controller, null);
						return;
					}
					if (result.kind === "error") {
						await finish(
							controller,
							JSON.stringify({ error: { message: GUEST_STOPPED_MESSAGE } })
						);
						return;
					}
					if (result.kind === "text") {
						const text = result.text.slice(0, MAX_ANSWER_CHARS - chars);
						chars += text.length;
						controller.enqueue(
							sse(JSON.stringify({ choices: [{ delta: { content: text } }] }))
						);
						if (chars >= MAX_ANSWER_CHARS) {
							await finish(controller, null);
						}
						return;
					}
					continue;
				}
				let chunk: Awaited<ReturnType<typeof reader.read>>;
				try {
					chunk = await reader.read();
				} catch {
					await finish(
						controller,
						JSON.stringify({ error: { message: GUEST_STOPPED_MESSAGE } })
					);
					return;
				}
				if (chunk.done) {
					await finish(controller, null);
					return;
				}
				bytes += chunk.value.byteLength;
				if (bytes > MAX_UPSTREAM_BYTES) {
					await finish(
						controller,
						JSON.stringify({ error: { message: GUEST_STOPPED_MESSAGE } })
					);
					return;
				}
				buffer += decoder
					.decode(chunk.value, { stream: true })
					.replace(/\r\n/gu, "\n");
			}
		},
		async cancel() {
			finished = true;
			await reader.cancel().catch(() => undefined);
		},
	});
}

export function GET(): Response {
	return json({ available: guestChatConfig() !== null });
}

export function POST(request: Request): Promise<Response> {
	return handleGuestChatPost(request);
}

export async function handleGuestChatPost(
	request: Request,
	deps: { env?: NodeJS.ProcessEnv; fetcher?: GuestFetch } = {}
): Promise<Response> {
	const config = guestChatConfig(deps.env);
	if (!originAllowed(request, config?.allowedOrigins ?? null)) {
		return failure("Cross-origin requests are not allowed.", 403);
	}
	if (
		!request.headers
			.get("content-type")
			?.toLowerCase()
			.startsWith("application/json")
	) {
		return failure("Expected an application/json request.", 415);
	}
	if (!config) {
		return failure(GUEST_UNAVAILABLE_MESSAGE, 503);
	}
	const raw = await readBoundedText(request);
	if (raw === null) {
		return failure("Request body is too large.", 413);
	}
	let parsed: ReturnType<typeof guestChatInputSchema.safeParse>;
	try {
		parsed = guestChatInputSchema.safeParse(JSON.parse(raw));
	} catch {
		return failure("Request body must be valid JSON.", 400);
	}
	if (!parsed.success) {
		return failure(
			`Ask a question under ${MAX_GUEST_QUESTION_CHARS} characters.`,
			400
		);
	}
	const bucket = guestClientBucket(request, config);
	if (!bucket) {
		return failure(GUEST_UNAVAILABLE_MESSAGE, 503);
	}
	const now = Date.now();
	if (visitorLimited(bucket, now)) {
		return failure(
			"Guest chat is rate-limited. Try again in a few minutes.",
			429,
			{ "Retry-After": "600" }
		);
	}
	if (globalLimited(now)) {
		return failure(GUEST_BUSY_MESSAGE, 429, { "Retry-After": "60" });
	}

	const { question } = parsed.data;
	const references = findRelevantDocs(question);
	const systemPrompt = [
		buildAssistantSystemPrompt(references),
		"You have no tools. Answer in plain text only, using public context and the visitor's question.",
	].join("\n\n");
	const fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let upstream: Response;
	try {
		upstream = await fetcher(`${config.gatewayUrl}/v1/chat/completions`, {
			body: JSON.stringify({
				model: config.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: question },
				],
				max_tokens: 1200,
				stream: true,
			}),
			cache: "no-store",
			headers: {
				Accept: "text/event-stream",
				Authorization: `Bearer ${config.gatewayKey}`,
				"Content-Type": "application/json",
				"x-ryu-end-user": guestEndUserId(bucket, config.gatewayKey),
			},
			method: "POST",
			redirect: "error",
			signal: AbortSignal.any([request.signal, timeout]),
		});
	} catch (error) {
		if (request.signal.aborted) {
			throw error;
		}
		return failure(GUEST_UNAVAILABLE_MESSAGE, 503);
	}
	if (!upstream.ok) {
		return gatewayRefusal(upstream);
	}
	if (!upstream.body) {
		return failure(GUEST_UNAVAILABLE_MESSAGE, 503);
	}
	return new Response(relayGuestStream(upstream.body), {
		headers: {
			"Cache-Control": "no-store, no-transform",
			"Content-Type": "text/event-stream; charset=utf-8",
			"X-Accel-Buffering": "no",
		},
	});
}
