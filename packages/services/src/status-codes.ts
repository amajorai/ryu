// packages/services/src/status-codes.ts
//
// HTTP status -> stable `{ code, title }`, kept in lockstep with
// `STATUS_DESCRIPTIONS` in apps/server/src/problem-details.ts (the
// control-plane host's problem+json table). `status-codes.test.ts` checks every
// row against `problemDetails({ status })`, so a server change fails here first.

/** The default machine code and human title for an HTTP status. */
export interface StatusDescription {
	readonly code: string;
	readonly title: string;
}

/** Statuses with their own code. Anything else falls back to `client_error` / `server_error`. */
export const STATUS_CODES: Readonly<Record<number, StatusDescription>> = {
	400: { code: "bad_request", title: "Bad Request" },
	401: { code: "unauthenticated", title: "Unauthorized" },
	403: { code: "forbidden", title: "Forbidden" },
	404: { code: "not_found", title: "Not Found" },
	405: { code: "method_not_allowed", title: "Method Not Allowed" },
	409: { code: "conflict", title: "Conflict" },
	410: { code: "gone", title: "Gone" },
	413: { code: "payload_too_large", title: "Content Too Large" },
	415: { code: "unsupported_media_type", title: "Unsupported Media Type" },
	422: { code: "unprocessable_content", title: "Unprocessable Content" },
	429: { code: "rate_limited", title: "Too Many Requests" },
	500: { code: "internal_error", title: "Internal Server Error" },
	502: { code: "bad_gateway", title: "Bad Gateway" },
	503: { code: "service_unavailable", title: "Service Unavailable" },
	504: { code: "gateway_timeout", title: "Gateway Timeout" },
};

const CLIENT_ERROR: StatusDescription = {
	code: "client_error",
	title: "Client Error",
};
const SERVER_ERROR: StatusDescription = {
	code: "server_error",
	title: "Server Error",
};

/** The default `{ code, title }` for `status`, as the control-plane host would answer it. */
export function describeStatus(status: number): StatusDescription {
	return STATUS_CODES[status] ?? (status >= 500 ? SERVER_ERROR : CLIENT_ERROR);
}
