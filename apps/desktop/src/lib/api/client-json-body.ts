import type { z } from "zod";
import { parseApiErrorBody } from "./client-errors.ts";

/** A response body read once and decoded leniently by {@link readJsonBody}. */
export interface JsonBody<T> {
	/** The parsed JSON body, or `null` when the body was empty or not JSON. */
	data: T | null;
	/**
	 * A human-readable failure message, or `null` when the response was a 2xx
	 * carrying a JSON (or empty) body. Set for every non-2xx, and for a 2xx whose
	 * body is not JSON at all — a caller can treat a non-null `error` as "failed"
	 * without ever calling `JSON.parse` itself.
	 */
	error: string | null;
	status: number;
}

/** Collapse a raw error body to one short line so a stray HTML page or stack
 *  trace cannot fill a panel. */
function snippet(text: string): string {
	return text.trim().replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Read a response body ONCE and decode it as JSON without ever throwing a
 * `SyntaxError` at the caller.
 *
 * This exists because the hand-rolled `fetch` clients used to call `resp.json()`
 * before checking `resp.ok`: any non-JSON error body (an axum extractor
 * rejection is `text/plain`, a proxy error page is HTML) surfaced in the UI as
 * `Unexpected token 'E', "Expected r"... is not valid JSON` instead of the real
 * reason. Status is inspected first here, the body is read as text, and JSON is
 * only attempted — never required.
 *
 * `label` names the operation for the fallback message (`"<label> failed: 415"`).
 * When the failing body is not JSON its first line is appended, so the server's
 * actual complaint still reaches the user.
 */
export async function readJsonBody<T>(
	resp: Response,
	label: string,
	codec: z.ZodType<T>
): Promise<JsonBody<T>> {
	const text = await resp.text().catch(() => "");
	let data: T | null = null;
	let decodedJson = false;
	let validContract = false;
	if (text) {
		try {
			const parsed = codec.safeParse(JSON.parse(text));
			decodedJson = true;
			if (parsed.success) {
				data = parsed.data;
				validContract = true;
			}
		} catch {
			// Not JSON — `data` stays null and the raw text becomes the message.
			data = null;
		}
	}

	if (resp.ok) {
		if (text && !decodedJson) {
			// A 2xx that is not JSON means we reached something that is not this
			// node's API (SPA/proxy fallback serving index.html), same failure mode
			// `request()` reports below.
			const contentType = resp.headers.get("content-type") ?? "unknown";
			return {
				data: null,
				status: resp.status,
				error: `${label} returned ${contentType}, not JSON — the node URL may be wrong or unreachable.`,
			};
		}
		if (text && !validContract) {
			return {
				data: null,
				status: resp.status,
				error: `${label} returned an invalid response.`,
			};
		}
		return { data, status: resp.status, error: null };
	}

	const serverError = parseApiErrorBody(text);
	if (serverError.message) {
		return { data, status: resp.status, error: serverError.message };
	}
	const base = `${label} failed: ${resp.status}`;
	const detail = snippet(text);
	return {
		data,
		status: resp.status,
		error: detail ? `${base} — ${detail}` : base,
	};
}
