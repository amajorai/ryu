import { z } from "zod";

const SIGN_IN_AGAIN =
	"Sign out from your account menu and sign in again, then try again.";
const CONFIRM_TWO_FACTOR =
	"If it requires two-factor, sign out from your account menu and sign in again with a passkey or your authenticator app, or confirm with your authenticator app by running `ryu-cli secrets confirm CODE --method totp` in a terminal. Then try again.";

/**
 * What the desktop says for the control plane's refusals of a request Core
 * forwarded for you (Team and Organization vault values). Core passes them
 * through as `{ code, error }`, so the server message alone is just
 * "Unauthorized".
 */
const CONTROL_PLANE_REFUSAL_MESSAGES = new Map<string, string>([
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
		`This node's organization requires two-factor. Turn on two-factor for your account. ${SIGN_IN_AGAIN}`,
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
		`Your sign-in on this machine has ended or was revoked. ${SIGN_IN_AGAIN}`,
	],
	[
		"user_jwt_invalid",
		`Ryu didn't accept this machine's sign-in token. A new one is fetched on the next request, so try again in a minute. If it keeps happening: ${SIGN_IN_AGAIN}`,
	],
	[
		"personal_node_required",
		"Changes to Team and Organization values, and change-request decisions, go through your own personal node, not an organization or team node. Make the change from your own Ryu or the web console.",
	],
	[
		"node_proxy_required",
		"This node can't act for you on shared values: it is someone else's personal node, a team node for a team you're not on, or its enrollment was revoked.",
	],
	["not_an_org_member", "You're not a member of this node's organization."],
	[
		"user_jwt_lookup_unavailable",
		"Ryu couldn't check your sign-in just now. Try again shortly.",
	],
	[
		"mfa_enrollment_required",
		"Your account needs an authenticator app or a passkey before it can use Team and Organization values. Set one up in your account's security settings, then try again.",
	],
	[
		"staff_session_factor_required",
		"Ryu staff sign-ins must be confirmed with an authenticator app, a recovery code or a passkey. Sign out from your account menu and sign in again with your passkey or authenticator app, then try again.",
	],
]);

const codedErrorSchema = z.object({ code: z.string() });

/** The message for a control-plane refusal Core passed through, if any. */
export function controlPlaneRefusalMessage(error: unknown): string | undefined {
	const coded = codedErrorSchema.safeParse(error);
	return coded.success
		? CONTROL_PLANE_REFUSAL_MESSAGES.get(coded.data.code)
		: undefined;
}

/**
 * The `sharedError` prefix Core uses when the control plane refused your
 * access to shared values during an export; the refusal code follows.
 */
const SHARED_REFUSED_PREFIX = "vault_shared_refused: ";

/**
 * What to say when an export left the Team and Organization values out:
 * the refusal's own message when the control plane refused you, otherwise
 * that they could not be loaded.
 */
export function sharedValuesMissingMessage(sharedError: string): string {
	const code = sharedError.startsWith(SHARED_REFUSED_PREFIX)
		? sharedError.slice(SHARED_REFUSED_PREFIX.length).trim()
		: "";
	const refusal = code ? CONTROL_PLANE_REFUSAL_MESSAGES.get(code) : undefined;
	const base = "This export has your own and this node's secrets only.";
	return refusal
		? `Shared secrets were left out: ${refusal} ${base}`
		: `Shared secrets could not be loaded. ${base}`;
}
