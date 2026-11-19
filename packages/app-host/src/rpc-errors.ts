import { z } from "zod";

// Error transport shared by unary and streaming host RPC.

/** A structured error the host relays to a widget (decisions doc D6). `code` is a
 *  closed enum so the widget can branch without string matching; `message` is a
 *  human-readable detail. The legacy plugin path still uses a plain string error,
 *  so {@link RpcResponse.error} is a union and every reader must accept both. */
export interface RpcErrorPayload {
	code: WidgetRpcErrorCode;
	message: string;
	/** The server's own refusal sentence for a failed `app.request`, shown to
	 *  the user in place of the transport text in `message`. */
	reason?: string;
	/** HTTP status of a failed `app.request` (400 to 599). */
	status?: number;
}

/** Longest relayed server reason; longer bodies are developer detail. */
export const MAX_RPC_REASON_LENGTH = 500;

/** The closed set of widget RPC error codes (decisions doc D6). */
export type WidgetRpcErrorCode =
	| "denied"
	| "not_found"
	| "over_budget"
	| "server_error"
	| "invalid_args";

export const widgetRpcErrorCodeSchema = z.enum([
	"denied",
	"not_found",
	"over_budget",
	"server_error",
	"invalid_args",
] satisfies WidgetRpcErrorCode[]);

const publicRpcFailureSchema = z.object({
	code: z.string(),
	message: z.string().optional().catch(undefined),
});

/** C0 and C1 control characters (newlines, escapes): become a space. */
const CONTROL = /\p{Cc}+/gu;
/** Format characters (bidi overrides and isolates, zero-width space, BOM, tag
 *  characters): deleted so they cannot reorder or hide text in the companion or
 *  in Desktop chrome. ZWNJ, ZWJ (spelling in Persian and Indic scripts, emoji
 *  sequences) and the soft hyphen are kept. */
const FORMAT = /(?!\u200C|\u200D|\u00AD)\p{Cf}/gu;

/**
 * A server reason that may cross into a companion: control characters become
 * spaces, format characters other than ZWNJ, ZWJ and the soft hyphen are
 * deleted, whitespace collapses, and an empty result or one longer than
 * {@link MAX_RPC_REASON_LENGTH} is dropped (not cut short).
 */
export function sanitizeRpcReason(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return;
	}
	const cleaned = value
		.replace(CONTROL, " ")
		.replace(FORMAT, "")
		.replace(/\s+/gu, " ")
		.trim();
	return cleaned && cleaned.length <= MAX_RPC_REASON_LENGTH
		? cleaned
		: undefined;
}

/** A status whose body is client-facing by HTTP convention (400 to 499). */
export function isClientErrorStatus(status: number): boolean {
	return Number.isInteger(status) && status >= 400 && status < 500;
}

/** Thrown (and caught into an RpcResponse.error) when a call is not permitted.
 *  Serialized to a plain STRING error (the legacy plugin path shape). */
export class CapabilityError extends Error {}

/** A widget round-trip failure carrying a closed {@link WidgetRpcErrorCode}
 *  (decisions doc D6). Serialized by the host into a structured
 *  `{ code, message }` error, distinct from {@link CapabilityError}'s string. */
export class CodedRpcError extends Error {
	code: WidgetRpcErrorCode;
	constructor(code: WidgetRpcErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "CodedRpcError";
	}
}

/** The {@link WidgetRpcErrorCode} for an HTTP failure status. */
export function rpcErrorCodeForStatus(status: number): WidgetRpcErrorCode {
	if (status === 401 || status === 403) {
		return "denied";
	}
	if (status === 404 || status === 410) {
		return "not_found";
	}
	if (status === 402 || status === 429) {
		return "over_budget";
	}
	return status >= 400 && status < 500 ? "invalid_args" : "server_error";
}

/**
 * A failed `app.request`: keeps the transport `message` (`"<path> failed:
 * <status>"`, which existing companions parse) and adds the HTTP `status` and
 * the server's own `reason` so a companion can show the refusal sentence.
 */
export class AppRequestRpcError extends CodedRpcError {
	readonly reason?: string;
	readonly status: number;
	constructor(options: {
		code?: WidgetRpcErrorCode;
		message: string;
		reason?: string;
		status: number;
	}) {
		super(
			options.code ?? rpcErrorCodeForStatus(options.status),
			options.message
		);
		this.name = "AppRequestRpcError";
		this.status = options.status;
		// Only a 4xx body is client-facing; 5xx text is internal by default.
		const reason = isClientErrorStatus(options.status)
			? sanitizeRpcReason(options.reason)
			: undefined;
		if (reason !== undefined) {
			this.reason = reason;
		}
	}
}

/**
 * Serialize a thrown error into the `error` field of an {@link RpcResponse}. A
 * {@link CodedRpcError} (or anything carrying a PUBLIC widget `code`) becomes the
 * structured `{ code, message }` a widget expects (D6). An unknown string code is
 * normalized to `server_error` instead of escaping the closed wire vocabulary.
 * Everything else — notably the legacy {@link CapabilityError} — stays a plain
 * string so the existing plugin bridge (which checks `typeof error === "string"`)
 * is unaffected.
 */
export function toRpcError(cause: unknown): string | RpcErrorPayload {
	const failure = publicRpcFailureSchema.safeParse(cause);
	if (failure.success) {
		const publicCode = widgetRpcErrorCodeSchema.safeParse(failure.data.code);
		const payload: RpcErrorPayload = {
			code: publicCode.success ? publicCode.data : "server_error",
			message: failure.data.message ?? String(cause),
		};
		// `status` and `reason` cross only for a relayed app.request failure, and
		// the reason only for a 4xx, re-sanitized here so no other error type can
		// smuggle server text or control characters into a frame.
		if (cause instanceof AppRequestRpcError) {
			payload.status = cause.status;
			const reason = isClientErrorStatus(cause.status)
				? sanitizeRpcReason(cause.reason)
				: undefined;
			if (reason !== undefined) {
				payload.reason = reason;
			}
		}
		return payload;
	}
	return cause instanceof Error ? cause.message : String(cause);
}
