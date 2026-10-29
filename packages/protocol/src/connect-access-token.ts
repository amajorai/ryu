/**
 * Connect-audience access tokens (Treg parity B7). Ryu's control plane issues
 * a short-lived Ed25519-signed JWT access token (RFC 9068 `at+jwt`) for one
 * organization's Connect tenant, in exchange for a hosted OAuth access token
 * or a console session. Hosted Connect verifies it offline against the
 * control plane's public key: signature, issuer, audience, expiry and
 * lifetime, then maps it to the tenant the token names. It works beside the
 * self-serve Connect keys (A6) and resolves to the same tenant.
 *
 * The claims, limits and scopes here are the contract between the issuer
 * (`packages/api/src/lib/connect-access-token.ts`) and the verifier
 * (`apps/connect/src/oauth-token.ts`); both are held to
 * `fixtures/connect-access-token-cases-v1.json`, which carries a test-only
 * signing key, a golden token and refused variants.
 */

import { z } from "zod";

export const CONNECT_ACCESS_TOKEN_CONTRACT_VERSION = 1;
/** The JOSE `typ` header: an OAuth 2.0 JWT access token (RFC 9068). */
export const CONNECT_ACCESS_TOKEN_TYP = "at+jwt";
export const CONNECT_ACCESS_TOKEN_ALG = "EdDSA";
/** What the issuer grants unless asked for less. */
export const CONNECT_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 600;
/** The verifier refuses any token whose lifetime is longer than this. */
export const CONNECT_ACCESS_TOKEN_MAX_TTL_SECONDS = 900;
/** Clock skew the verifier allows on `iat`, `nbf` and `exp`. */
export const CONNECT_ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 60;
/** The largest token, in bytes, either side handles. */
export const CONNECT_ACCESS_TOKEN_MAX_BYTES = 4096;

/**
 * Connect understands two of Ryu's shared OAuth scopes: `tools:read` (search,
 * describe, list, balance and usage reads) and `tools:exec` (calls). A token
 * without `tools:read` is never issued.
 */
export const CONNECT_ACCESS_TOKEN_SCOPES = [
	"tools:read",
	"tools:exec",
] as const;
export type ConnectAccessTokenScope =
	(typeof CONNECT_ACCESS_TOKEN_SCOPES)[number];

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TENANT = /^org_[A-Za-z0-9_-]{1,128}$/u;

export const connectAccessTokenClaimsSchema = z.strictObject({
	aud: z.string().min(1).max(512),
	client_id: z.string().min(1).max(256),
	exp: z.number().int().positive(),
	iat: z.number().int().positive(),
	iss: z.string().min(1).max(512),
	jti: z.string().min(1).max(128),
	nbf: z.number().int().positive(),
	org_id: z.string().regex(ID),
	org_role: z.string().min(1).max(64),
	scope: z.string().max(256),
	sub: z.string().min(1).max(128),
	team_id: z.string().regex(ID).optional(),
	tenant: z.string().regex(TENANT),
});
export type ConnectAccessTokenClaims = z.output<
	typeof connectAccessTokenClaimsSchema
>;

/** Why the verifier refuses a token. Each answers `401 invalid_token`. */
export const CONNECT_TOKEN_REFUSALS = [
	"malformed",
	"unsupported_algorithm",
	"unknown_key",
	"bad_signature",
	"bad_claims",
	"wrong_issuer",
	"wrong_audience",
	"expired",
	"not_yet_valid",
	"lifetime_too_long",
	"tenant_mismatch",
	"no_read_scope",
] as const;
export type ConnectTokenRefusal = (typeof CONNECT_TOKEN_REFUSALS)[number];
