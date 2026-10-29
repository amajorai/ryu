// packages/services/src/box/codes.ts
//
// Every error code Ryu Box answers with, in the order of the `BoxErrorCode`
// union in apps/box/src/errors.ts. `box.test.ts` reads that union from the
// server source and fails when the two differ, so a code the server adds
// cannot go unnoticed. The SDK maps them through the generic error table:
// `quota_exceeded` is a RyuQuotaExceededError and `insufficient_credits` a
// RyuPaymentRequiredError, and neither is retried.

/** Error codes the Box service sends, as `error.code` in its `box.error` envelope. */
export const BOX_ERROR_CODES = [
	"unauthorized",
	"invalid_json",
	"invalid_request",
	"body_too_large",
	"quota_exceeded",
	"insufficient_credits",
	"not_found",
	"conflict",
	"idempotency_conflict",
	"idempotency_key_resource_deleted",
	"box_not_ready",
	"box_busy",
	"forbidden",
	"not_supported",
	"secrets_unavailable",
	"driver_unavailable",
	"driver_not_safe",
	"driver_failed",
	"upstream_not_configured",
	"upstream_unavailable",
	"upstream_timeout",
	"upstream_account_conflict",
	"upstream_account_unverified",
	"request_failed",
	"capacity_unavailable",
	"billing_owner_mismatch",
	"stream_direct_only",
	"token_replayed",
] as const;

/** One Box error code. */
export type BoxErrorCode = (typeof BOX_ERROR_CODES)[number];

/** Codes `box.run()` raises itself when the Box never becomes usable. */
export const BOX_RUN_CODES = {
	/** The Box ended in `error` (or another unusable status) while it was provisioning. */
	failed: "box_failed",
	/**
	 * `readyTimeoutMs` elapsed while the Box was still provisioning (a
	 * RyuTimeoutError). Distinct from the service's `409 box_not_ready`.
	 */
	readyTimeout: "box_ready_timeout",
} as const;
