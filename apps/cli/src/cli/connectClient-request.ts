// The request plumbing under `connectClient.ts`: service URL checks, bounded
// reads, and one JSON request whose refusal becomes a ConnectError. Messages
// the client writes itself are localized text, so `--json` keeps the English
// sentence and human output renders it in the CLI locale; a server's own
// `error` text stays as sent.

import type { z } from "zod";
import { refusalSchema } from "./connectClient-schemas.ts";
import {
	LocalizedError,
	type LocalizedText,
	localize,
} from "./localizedText.ts";

export type FetchLike = (
	input: string | URL,
	init?: RequestInit
) => Promise<Response>;

export interface ClientOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	userAgent?: string;
}

/** Answers larger than this are refused; Connect caps tool answers well below it. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A refused or failed request, carrying Connect's `code` and fields. */
export class ConnectError extends LocalizedError {
	readonly body: Record<string, unknown>;
	readonly code: string;
	readonly retryAfterSeconds: number | null;
	readonly status: number;

	constructor(
		status: number,
		code: string,
		message: string | LocalizedText,
		body: Record<string, unknown> = {},
		retryAfterSeconds: number | null = null
	) {
		super(message);
		this.status = status;
		this.code = code;
		this.body = body;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** Which configured URL a check is about; each names it in a whole sentence. */
export type ServiceUrlKind = "catalog" | "connect";

function notAbsolute(kind: ServiceUrlKind): LocalizedText {
	return kind === "connect"
		? localize("The Connect URL must be an absolute URL.")
		: localize("The catalog URL must be an absolute URL.");
}

function notSafe(kind: ServiceUrlKind): LocalizedText {
	return kind === "connect"
		? localize(
				"The Connect URL must use HTTPS (or HTTP to localhost) without credentials, a query or a fragment."
			)
		: localize(
				"The catalog URL must use HTTPS (or HTTP to localhost) without credentials, a query or a fragment."
			);
}

/** HTTPS, or HTTP to loopback, with no credentials, query or fragment. */
export function parseServiceUrl(value: string, kind: ServiceUrlKind): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new LocalizedError(notAbsolute(kind));
	}
	if (
		!(
			url.protocol === "https:" ||
			(url.protocol === "http:" && LOOPBACK.has(url.hostname))
		) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new LocalizedError(notSafe(kind));
	}
	return url;
}

function tooLarge(status: number): ConnectError {
	return new ConnectError(
		status,
		"answer_too_large",
		localize("The answer is too large.")
	);
}

async function readBounded(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) {
		await response.body?.cancel();
		throw tooLarge(response.status);
	}
	const reader = response.body?.getReader();
	if (!reader) {
		return "";
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		size += value.byteLength;
		if (size > MAX_ANSWER_BYTES) {
			await reader.cancel();
			throw tooLarge(response.status);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function retryAfter(response: Response): number | null {
	const value = response.headers.get("retry-after")?.trim();
	return value && /^\d{1,9}$/u.test(value) ? Number(value) : null;
}

async function send(
	fetchImpl: FetchLike,
	url: URL,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	try {
		return await fetchImpl(url, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const origin = url.origin;
		throw new ConnectError(
			0,
			"unreachable",
			error instanceof Error && error.name === "TimeoutError"
				? localize("{origin} timed out.", { origin })
				: localize("{origin} is unreachable.", { origin })
		);
	}
}

/** One JSON request; a non-2xx answer becomes a ConnectError with Connect's code. */
export async function requestJson<T>(
	fetchImpl: FetchLike,
	url: URL,
	schema: z.ZodType<T>,
	init: RequestInit,
	timeoutMs: number
): Promise<T> {
	const response = await send(fetchImpl, url, init, timeoutMs);
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		throw new ConnectError(
			response.status,
			"redirect_refused",
			localize("The server redirected the request; it was not followed.")
		);
	}
	const text = await readBounded(response);
	let decoded: unknown;
	try {
		decoded = text === "" ? {} : JSON.parse(text);
	} catch {
		throw new ConnectError(
			response.status,
			"invalid_answer",
			localize("The server answered HTTP {status} without JSON.", {
				status: response.status,
			})
		);
	}
	if (!response.ok) {
		const refusal = refusalSchema.safeParse(decoded);
		const body = refusal.success ? refusal.data : {};
		const code = body.code ?? `http_${response.status}`;
		throw new ConnectError(
			response.status,
			code,
			body.error ?? `${code} (HTTP ${response.status})`,
			body,
			retryAfter(response)
		);
	}
	const parsed = schema.safeParse(decoded);
	if (!parsed.success) {
		throw new ConnectError(
			response.status,
			"invalid_answer",
			localize("The server's answer does not match the Connect API.")
		);
	}
	return parsed.data;
}
