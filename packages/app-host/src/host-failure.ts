// Companion-side reading of a failed host call. When an `app.request` to the
// app's own sidecar fails with a 4xx, the host rejects with an `Error` whose
// `message` is transport text (`"<path> failed: <status>"`) and which also
// carries the HTTP `status` and the server's own `reason` sentence. A 5xx, or a
// request to another app, carries no reason.
// Show the reason to the user (it is the backend's catalogued refusal copy, which
// the DOM localizer translates), and fall back to status wording when absent.

import { sanitizeRpcReason } from "./rpc-errors.ts";

function field(cause: unknown, name: "reason" | "status"): unknown {
	return typeof cause === "object" && cause !== null && name in cause
		? (cause as Record<string, unknown>)[name]
		: undefined;
}

/** The server's refusal sentence carried by a failed host call, or null. */
export function hostFailureReason(cause: unknown): string | null {
	// Re-sanitized on this side too: an older or third-party host may relay
	// control or bidi characters the host side would have stripped.
	return sanitizeRpcReason(field(cause, "reason")) ?? null;
}

const BRIDGE_STATUS = /\bfailed: (\d{3})\s*$/u;

/**
 * The HTTP status of a failed host call: the relayed `status`, else the status
 * at the end of the transport message (hosts older than the relay), else null.
 */
export function hostFailureStatus(cause: unknown): number | null {
	const status = field(cause, "status");
	if (typeof status === "number" && status >= 400 && status < 600) {
		return status;
	}
	const message = cause instanceof Error ? cause.message : "";
	const match = BRIDGE_STATUS.exec(message);
	return match?.[1] ? Number(match[1]) : null;
}
