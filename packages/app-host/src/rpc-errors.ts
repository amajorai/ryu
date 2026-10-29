import { z } from "zod";

// Error transport shared by unary and streaming host RPC.

/** A structured error the host relays to a widget (decisions doc D6). `code` is a
 *  closed enum so the widget can branch without string matching; `message` is a
 *  human-readable detail. The legacy plugin path still uses a plain string error,
 *  so {@link RpcResponse.error} is a union and every reader must accept both. */
export interface RpcErrorPayload {
	code: WidgetRpcErrorCode;
	message: string;
}

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
		return {
			code: publicCode.success ? publicCode.data : "server_error",
			message: failure.data.message ?? String(cause),
		};
	}
	return cause instanceof Error ? cause.message : String(cause);
}
