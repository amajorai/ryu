import { createHmac } from "node:crypto";

/**
 * Request headers that make Better Auth read ONE session from its own signed
 * session cookie. Server-only, for code that already decided which stored
 * session a request acts as (the forwarded user JWT binding in
 * `packages/api/src/lib/forwarded-user-jwt.ts`) and wants Better Auth's own
 * `getSession` to produce the principal.
 *
 * `token` is the `token` of a session row as the adapter returned it. A row
 * read by anything but its token carries an opaque handle, not the raw token
 * (`auth-token-at-rest.ts`). The adapter resolves a handle to its row, but a
 * handle is no bearer: the bearer plugin refuses a value with dots, and a
 * cookie is only accepted with this server's signature. Signing it here, in
 * process, is what lets a server-chosen session resolve without the raw
 * token ever being kept or handed back. The headers must never leave this
 * process or be logged.
 */

/** The slice of Better Auth's context the cookie is built from. */
export interface SessionCookieContext {
	readonly authCookies: { readonly sessionToken: { readonly name: string } };
	readonly secret: string;
}

export function signedSessionCookieHeaders(
	context: SessionCookieContext,
	token: string
): Headers {
	// The cookie format Better Auth verifies: `value.signature`, URL-encoded,
	// where the signature is the base64 HMAC-SHA-256 of the value.
	const signature = createHmac("sha256", context.secret)
		.update(token)
		.digest("base64");
	return new Headers({
		cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(
			`${token}.${signature}`
		)}`,
	});
}
