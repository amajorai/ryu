import { z } from "zod";

/**
 * The identity claims every session JWT minted by `/api/auth/token` carries.
 * Core decodes these exact keys (`identity_verify::RawClaims`), so they are a
 * wire contract: renaming one silently drops it on the Core side.
 *
 * Every token also carries {@link JWT_SESSION_CLAIM} (`ryu_sid`), the id of the
 * Better Auth session row it was minted from. Core ignores it (`RawClaims`
 * skips unknown fields). The control plane requires it when Core forwards the
 * token on a vault or GitHub token request (`packages/api/src/lib/
 * forwarded-user-jwt.ts`): the row must still be live, so signing out or
 * revoking that sign-in stops the token at once, and the session's own
 * step-up grants and access-policy facts apply to it.
 */
export interface JwtIdentityClaims {
	email: string;
	/**
	 * OIDC-style proof that the user owns `email`. Core forwards the address to
	 * apps that grant access by email (Sites' named editors and invited viewers)
	 * only when this is `true`.
	 */
	email_verified: boolean;
	id: string;
}

/** The Better Auth user fields the identity claims are derived from. */
export interface JwtIdentityUser {
	email: string;
	emailVerified?: boolean | null;
	id: string;
}

/**
 * Derive the identity claims from the Better Auth user record. Only a stored
 * `emailVerified: true` is verified: SSO users (whose provider is not trusted
 * for verification), unverified social accounts, and admin- or SCIM-created
 * users can all hold a session for an address they have not proven to own.
 */
export function jwtIdentityClaims(user: JwtIdentityUser): JwtIdentityClaims {
	return {
		email: user.email,
		email_verified: user.emailVerified === true,
		id: user.id,
	};
}

/**
 * The claim naming the session a token was minted from. It is namespaced, so
 * an OIDC `sid` from another issuer can never satisfy it. Its value is the
 * session row id, never the session token (a bearer credential).
 */
export const JWT_SESSION_CLAIM = "ryu_sid";

const sessionBindingSchema = z.object({ id: z.string().min(1).max(128) });

/**
 * The session-binding claim for the session a token is minted from. Throws
 * when the session has no usable id: a token that cannot be bound to a live
 * session must not be minted at all.
 */
export function jwtSessionBindingClaims(session: unknown): {
	[JWT_SESSION_CLAIM]: string;
} {
	const parsed = sessionBindingSchema.safeParse(session);
	if (!parsed.success) {
		throw new Error("cannot bind a JWT to a session without an id");
	}
	return { [JWT_SESSION_CLAIM]: parsed.data.id };
}
