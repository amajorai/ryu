// packages/services/src/notify/codes.ts
//
// Ryu Notify error codes, copied (not imported: the published SDK never
// depends on apps/notify) from the `NotifyErrorCode` union in
// apps/notify/src/errors.ts. test/conformance/notify.test.ts scrapes that
// union and fails when the server adds a code this list lacks. Branch on an
// unknown code by its HTTP status.

/** Every Ryu Notify error code, in the order the server declares them. */
export const NOTIFY_ERROR_CODES = [
	"body_too_large",
	"conflict",
	"idempotency_conflict",
	"insufficient_credits",
	"invalid_cursor",
	"invalid_json",
	"invalid_request",
	"method_not_allowed",
	"not_found",
	"rate_limited",
	"request_failed",
	"secrets_unavailable",
	"too_many_streams",
	"unauthorized",
	"unsupported_media_type",
] as const;

/** A Ryu Notify error code known to this SDK version. */
export type NotifyErrorCode = (typeof NOTIFY_ERROR_CODES)[number];

/** True when `code` is a Notify error code this SDK version knows. */
export function isNotifyErrorCode(code: string): code is NotifyErrorCode {
	return (NOTIFY_ERROR_CODES as readonly string[]).includes(code);
}
