import { z } from "zod";
import { tf } from "../i18n/translate.ts";

const nativeErrorSchema = z.instanceof(Error);

/** Normalize caught values without changing native error messages. */
export function nativeErrorMessage(
	value: Parameters<typeof nativeErrorSchema.safeParse>[0]
): string {
	const parsed = nativeErrorSchema.safeParse(value);
	return parsed.success ? parsed.data.message : String(value);
}

// Bun reports refused sockets as code "ConnectionRefused"; Node as ECONNREFUSED.
// An AbortError here is a health/request timeout, which reads the same to a user.
const CONNECTION_CODES = new Set([
	"ConnectionRefused",
	"ECONNREFUSED",
	"ENOTFOUND",
	"ETIMEDOUT",
	"ECONNRESET",
	"FailedToOpenSocket",
]);
const CONNECTION_MESSAGE =
	/Unable to connect|ECONNREFUSED|ENOTFOUND|fetch failed|Failed to fetch|socket connection was closed/i;
const HTTP_STATUS_MESSAGE = /failed: (\d{3})\b|\bHTTP (\d{3})\b/;

const errorFieldsSchema = z.looseObject({
	code: z.string().optional(),
	name: z.string().optional(),
	path: z.string().optional(),
	status: z.number().optional(),
});

const zodIssueSchema = z.looseObject({
	message: z.string(),
	path: z.array(z.union([z.string(), z.number()])).optional(),
});
const zodIssuesSchema = z.array(zodIssueSchema).min(1);
const zodErrorSchema = z.instanceof(z.ZodError);

/**
 * Core's refusal for a signed-in caller whose token carries no claim for the
 * node's organization: an organization whose policy refuses the session (most
 * often required two-factor) is left out of the token when it is minted.
 */
export const ORG_ACCESS_NOT_IN_SESSION_CODE = "org_access_not_in_session";

/** What the CLI says instead of a bare 403 for that refusal. */
export const ORG_ACCESS_NOT_IN_SESSION_HINT =
	"Your sign-in doesn't include access to this node's organization (403). If you're a member and it requires two-factor, confirm with your authenticator app: `ryu-cli secrets confirm CODE --method totp`, then retry. Or sign in again with a passkey or your authenticator app: `ryu-cli logout`, then `ryu-cli login`.";

/** Whether a caught value is Core's {@link ORG_ACCESS_NOT_IN_SESSION_CODE}. */
export function isOrgAccessNotInSession(value: unknown): boolean {
	const fields = errorFieldsSchema.safeParse(value);
	return (
		fields.success &&
		fields.data.code === ORG_ACCESS_NOT_IN_SESSION_CODE &&
		(fields.data.status === undefined || fields.data.status === 403)
	);
}

const SIGN_IN_AGAIN = "Sign in again: `ryu-cli logout`, then `ryu-cli login`.";
const CONFIRM_TWO_FACTOR =
	"If it requires two-factor, confirm with your authenticator app: `ryu-cli secrets confirm CODE --method totp`, then retry. Or sign in again with a passkey or your authenticator app: `ryu-cli logout`, then `ryu-cli login`.";

/**
 * What the CLI says for the control plane's refusals of a request Core
 * forwarded for you (Team and Organization vault values). Core passes these
 * through as `{ code, error }`; without this they read as a bare 401/403.
 */
const CONTROL_PLANE_REFUSAL_HINTS = new Map<string, string>([
	[
		"user_jwt_org_not_admitted",
		`Your sign-in doesn't include access to this node's organization: its access policy refused it. ${CONFIRM_TWO_FACTOR}`,
	],
	[
		"org_mfa_session_required",
		`This node's organization requires a sign-in with two-factor. ${CONFIRM_TWO_FACTOR}`,
	],
	[
		"org_mfa_required",
		"This node's organization requires two-factor. Turn on two-factor for your account, then sign in again: `ryu-cli logout`, then `ryu-cli login`.",
	],
	[
		"org_ip_not_allowed",
		"This node's organization doesn't allow requests from this node's network address. Ask an organization admin.",
	],
	[
		"org_session_expired",
		`Your sign-in is older than this node's organization allows. ${SIGN_IN_AGAIN}`,
	],
	[
		"user_jwt_session_ended",
		`The sign-in on this machine has ended or was revoked. ${SIGN_IN_AGAIN}`,
	],
	[
		"user_jwt_invalid",
		`The control plane didn't accept this machine's sign-in token. Ryu gets a new one on the next request, so try again in a minute. If it keeps happening: ${SIGN_IN_AGAIN}`,
	],
	[
		"personal_node_required",
		"Changes to Team and Organization values (and change-request decisions) go through your own personal node, not an organization or team node. Run the command against your own Ryu, or use the web console.",
	],
	[
		"node_proxy_required",
		"This node can't act for you on shared values: it is someone else's personal node, a team node for a team you're not on, or its enrollment was revoked.",
	],
	["not_an_org_member", "You're not a member of this node's organization."],
	[
		"user_jwt_lookup_unavailable",
		"The control plane couldn't check your sign-in just now. Try again shortly.",
	],
	[
		"mfa_enrollment_required",
		"Your account needs an authenticator app or a passkey before it can use Team and Organization values. Set one up in your account's security settings on the web, then try again.",
	],
	[
		"staff_session_factor_required",
		"Ryu staff sign-ins must be confirmed with an authenticator app, a recovery code or a passkey. Sign in again with your passkey or authenticator app: `ryu-cli logout`, then `ryu-cli login`.",
	],
]);

/**
 * The `sharedError` prefix Core uses when the control plane refused the
 * caller's access to shared values during an export; the refusal code follows.
 */
const SHARED_REFUSED_PREFIX = "vault_shared_refused: ";

/**
 * The refusal code behind an export's `sharedError`, when the control plane
 * refused the caller rather than being unreachable.
 */
export function sharedRefusalCode(sharedError: string): string | null {
	if (!sharedError.startsWith(SHARED_REFUSED_PREFIX)) {
		return null;
	}
	const code = sharedError.slice(SHARED_REFUSED_PREFIX.length).trim();
	return code.length > 0 ? code : null;
}

/**
 * The hint for an access refusal a person can act on: Core's own
 * {@link ORG_ACCESS_NOT_IN_SESSION_CODE}, or a control-plane refusal of a
 * request Core forwarded (`ApiError.code`).
 */
export function accessRefusalHint(
	value: unknown
): { code: string; hint: string } | null {
	if (isOrgAccessNotInSession(value)) {
		return {
			code: ORG_ACCESS_NOT_IN_SESSION_CODE,
			hint: ORG_ACCESS_NOT_IN_SESSION_HINT,
		};
	}
	const fields = errorFieldsSchema.safeParse(value);
	const code = fields.success ? fields.data.code : undefined;
	const hint = code ? CONTROL_PLANE_REFUSAL_HINTS.get(code) : undefined;
	return code && hint ? { code, hint } : null;
}

export interface HumanizeErrorContext {
	/** Base URL the failed request targeted, used to name host:port. */
	url?: string;
}

/** host:port (or the raw value) for a URL, for human-facing copy. */
export function displayHostPort(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

function firstIssueText(
	issues: ReadonlyArray<{ message: string; path?: readonly PropertyKey[] }>
): string {
	const issue = issues[0];
	if (!issue) {
		return "invalid data";
	}
	const path = (issue.path ?? []).map(String).join(".");
	return path ? `${path}: ${issue.message}` : issue.message;
}

function unexpectedResponseText(
	issues: Parameters<typeof firstIssueText>[0]
): string {
	return tf("Core returned an unexpected response ({detail})", {
		detail: firstIssueText(issues),
	});
}

/** Parse a message that is (or embeds) a serialized zod issue array. */
function issuesFromMessage(
	message: string
): z.infer<typeof zodIssuesSchema> | null {
	const start = message.indexOf("[");
	const end = message.lastIndexOf("]");
	if (start === -1 || end <= start) {
		return null;
	}
	try {
		const parsed = zodIssuesSchema.safeParse(
			JSON.parse(message.slice(start, end + 1))
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function statusOf(
	fields: z.infer<typeof errorFieldsSchema> | null,
	message: string
): number | null {
	if (fields?.status) {
		return fields.status;
	}
	const match = HTTP_STATUS_MESSAGE.exec(message);
	const raw = match?.[1] ?? match?.[2];
	return raw ? Number(raw) : null;
}

function unreachableText(
	fields: z.infer<typeof errorFieldsSchema> | null,
	ctx: HumanizeErrorContext | undefined
): string {
	const url = ctx?.url ?? fields?.path;
	return url
		? tf("Core isn't reachable at {hostPort}", {
				hostPort: displayHostPort(url),
			})
		: "Core isn't reachable";
}

/**
 * Turn a caught value into one line a person can act on: connection failures name
 * the node, schema mismatches name the first bad field instead of dumping zod's
 * JSON issue array, and 401/403 explain sign-in vs permission. Anything else keeps
 * its raw message (see nativeErrorMessage).
 */
export function humanizeError(
	value: unknown,
	ctx?: HumanizeErrorContext
): string {
	if (zodErrorSchema.safeParse(value).success) {
		const issues = zodErrorSchema.parse(value).issues;
		return unexpectedResponseText(issues);
	}
	const fieldsResult = errorFieldsSchema.safeParse(value);
	const fields = fieldsResult.success ? fieldsResult.data : null;
	const message = nativeErrorMessage(value);

	if (
		(fields?.code && CONNECTION_CODES.has(fields.code)) ||
		fields?.name === "AbortError" ||
		fields?.name === "TimeoutError" ||
		CONNECTION_MESSAGE.test(message)
	) {
		return unreachableText(fields, ctx);
	}

	const issues = issuesFromMessage(message);
	if (issues) {
		return unexpectedResponseText(issues);
	}

	const refusal = accessRefusalHint(value);
	if (refusal) {
		return refusal.hint;
	}
	const status = statusOf(fields, message);
	if (status === 401) {
		return "Core needs you to sign in again (401) - open Settings → Account";
	}
	if (status === 403) {
		return "You don't have permission for this on the current node (403)";
	}
	return message;
}
