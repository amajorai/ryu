/**
 * Marks a `/device/approve` call that comes from the passwordless login-approval
 * push (`POST /api/login-approvals/pending/:id/approve`).
 *
 * A push grant is started by anyone who knows the account email, so approving it
 * proves nothing about the requesting device beyond the matching code the
 * approver typed. The device session redeemed from it must prove its own factor:
 * the MFA enrollment plugin records no delegated strong-factor proof for a
 * marked approval. The marker can only withhold that proof, never grant it, so a
 * caller setting the header itself gains nothing.
 */
export const LOGIN_APPROVAL_PUSH_HEADER = "x-ryu-login-approval-push";

/** Copy `headers` and mark the copy as a login-approval push approval. */
export function withLoginApprovalPushMarker(headers: Headers): Headers {
	const marked = new Headers(headers);
	marked.set(LOGIN_APPROVAL_PUSH_HEADER, "1");
	return marked;
}

/** Whether either header set carries the login-approval push marker. */
export function isLoginApprovalPushApproval(ctx: {
	headers?: Headers;
	request?: Request;
}): boolean {
	return (
		ctx.request?.headers.has(LOGIN_APPROVAL_PUSH_HEADER) === true ||
		ctx.headers?.has(LOGIN_APPROVAL_PUSH_HEADER) === true
	);
}
