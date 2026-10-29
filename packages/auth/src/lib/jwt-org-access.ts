/**
 * Organization access policy for the org claims of a Better Auth account JWT.
 *
 * `definePayload` (in `../index.ts`) puts every organization the user belongs
 * to into the token (`orgs`, `teams`, `ryu_flags_org`), and a managed node's
 * Core verifies that token offline and grants the caller that org's role.
 * Core never sees the minting request's network address, the session's age or
 * how it was signed in, so an organization's access policy (IP allowlist,
 * required two-factor, session max age) must be applied HERE, when the token
 * is minted: an organization whose policy refuses this session is left out of
 * the token. The token lifetime (Better Auth's default is 15 minutes) bounds
 * how long a decision stands; every re-mint decides again.
 *
 * WHY A REGISTRY AND NOT AN IMPORT. The policy evaluator, the settings read and
 * the client-address rules live in `@ryu/api` (`lib/org-access-policy.ts`),
 * which depends on `@ryu/auth`. As with `core-flag-claim.ts`, `apps/server`
 * imports both and registers the implementation at boot. Single slot, last
 * wins.
 *
 * FAIL THE MINT, NOT THE CLAIM. For a user with memberships, a missing
 * registration, a throwing resolver or one that does not answer within
 * `RESOLVE_TIMEOUT_MS` rejects with {@link JwtOrgAccessUnavailableError}, and
 * `definePayload` turns that into a 503 the client retries. Minting anyway
 * without the org claims would hand an org member a 15-minute token that
 * silently locks them out of their org's nodes with no signal to retry. A
 * user with no memberships never reaches the resolver, so their token is
 * issued even while the policy store is down. Only `GET /api/auth/token`
 * mints (the per-`/get-session` JWT header is off), so sign-in and session
 * reads never fail here. An answer from the resolver is authoritative: an
 * organization it leaves out is a policy refusal, not an outage.
 *
 * Trade-off, accepted: during such an outage a member also cannot mint for
 * consumers that need no org claim, such as a remote personal node (it
 * admits by `sub` alone) or the native app's realtime JWT
 * (`apps/native/lib/realtime-jwt.ts`, which caches nothing on a failed mint
 * and asks again on its next call). Both recover on the first mint after the
 * policy store answers again; a token without org claims would instead shut
 * the member out of every organization node for its full 15 minutes.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getCurrentAuthContext } from "@better-auth/core/context";
import { APIError } from "better-auth/api";

/** What the resolver decides on: the mint's session, user and request. */
export interface JwtOrgAccessInput {
	/** The minting request's headers, or `null` outside a request. */
	headers: Headers | null;
	/** Distinct organization ids the user is a member of. */
	organizationIds: string[];
	/** The minting request's transport peer, when the server recorded it. */
	peerIp: string | null;
	/** Better Auth's session row for the mint. */
	session: unknown;
	/** Better Auth's user for the mint. */
	user: unknown;
}

/** Returns the ids (a subset of `organizationIds`) whose policy admits the mint. */
export type JwtOrgAccessResolver = (
	input: JwtOrgAccessInput
) => Promise<Iterable<string>>;

let resolver: JwtOrgAccessResolver | null = null;

/** Install the policy evaluator. Called once, from `apps/server` boot. */
export function registerJwtOrgAccessResolver(
	implementation: JwtOrgAccessResolver | null
): void {
	resolver = implementation;
}

/**
 * The transport peer of the auth request being handled. Better Auth's endpoint
 * context carries only the `Request`, which has no socket address, so the
 * server records it around `auth.handler` and the IP allowlist can tell a
 * direct caller from a trusted proxy the same way the API routes do.
 */
const authRequestPeer = new AsyncLocalStorage<{ peerIp: string | null }>();

/** Run `work` (an `auth.handler` call) with the request's transport peer. */
export function runWithAuthRequestPeer<T>(
	peerIp: string | null,
	work: () => T
): T {
	return authRequestPeer.run({ peerIp }, work);
}

/**
 * Upper bound on the policy decision per mint. A timeout fails the mint (503,
 * retried by the client) rather than stalling it.
 */
const RESOLVE_TIMEOUT_MS = 2000;

const TIMED_OUT = Symbol("jwt-org-access-timeout");

/** The code a mint refused for an unavailable policy decision answers with. */
export const JWT_ORG_ACCESS_UNAVAILABLE_CODE = "JWT_ORG_ACCESS_UNAVAILABLE";

/**
 * The 503 `definePayload` throws when the memberships or their access policy
 * cannot be read. Clients retry `/api/auth/token` (Core's `mint_user_jwt`
 * returns an error without caching; Desktop backs off and retries).
 */
export function jwtOrgAccessUnavailable(): APIError {
	return new APIError(
		"SERVICE_UNAVAILABLE",
		{
			code: JWT_ORG_ACCESS_UNAVAILABLE_CODE,
			message: "Organization access could not be checked. Try again.",
		},
		{ "Retry-After": "5" }
	);
}

/** Why the organization access decision for a mint could not be made. */
export type JwtOrgAccessUnavailableReason =
	| "error"
	| "timeout"
	| "unregistered";

/**
 * The organization access policy could not be evaluated for a mint. The mint
 * must fail (and be retried) rather than go out without the org claims.
 */
export class JwtOrgAccessUnavailableError extends Error {
	readonly reason: JwtOrgAccessUnavailableReason;

	constructor(reason: JwtOrgAccessUnavailableReason, options?: ErrorOptions) {
		super(
			`organization access decision for JWT unavailable (${reason})`,
			options
		);
		this.name = "JwtOrgAccessUnavailableError";
		this.reason = reason;
	}
}

async function withTimeout<T>(
	work: Promise<T>,
	timeoutMs: number
): Promise<T | typeof TIMED_OUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function mintRequestHeaders(): Promise<Headers | null> {
	try {
		const context = await getCurrentAuthContext();
		return context.headers ?? context.request?.headers ?? null;
	} catch {
		// Minted outside an endpoint: no request, so no client address. An org
		// with an IP allowlist then refuses, which is the fail-closed answer.
		return null;
	}
}

/**
 * The membership rows whose organization's access policy admits this mint.
 *
 * Rejects with {@link JwtOrgAccessUnavailableError} when the decision cannot
 * be made (no resolver registered, the resolver throws, or it does not answer
 * within `timeoutMs`). A user with no membership rows resolves to `[]` without
 * consulting the resolver, so their mint never depends on the policy store.
 */
export async function admitJwtOrgMemberships<
	Row extends { organizationId: unknown },
>(
	rows: readonly Row[],
	mint: { session: unknown; user: unknown },
	timeoutMs: number = RESOLVE_TIMEOUT_MS
): Promise<Row[]> {
	if (rows.length === 0) {
		return [];
	}
	const implementation = resolver;
	if (!implementation) {
		console.error(
			"[auth] no organization access resolver is registered; refusing to mint the JWT"
		);
		throw new JwtOrgAccessUnavailableError("unregistered");
	}
	let allowed: Iterable<string> | typeof TIMED_OUT;
	try {
		const organizationIds = [
			...new Set(rows.map((row) => String(row.organizationId))),
		];
		allowed = await withTimeout(
			implementation({
				headers: await mintRequestHeaders(),
				organizationIds,
				peerIp: authRequestPeer.getStore()?.peerIp ?? null,
				session: mint.session,
				user: mint.user,
			}),
			timeoutMs
		);
	} catch (error) {
		console.error("[auth] organization access decision for JWT failed:", error);
		throw new JwtOrgAccessUnavailableError("error", { cause: error });
	}
	if (allowed === TIMED_OUT) {
		console.error("[auth] organization access decision for JWT timed out");
		throw new JwtOrgAccessUnavailableError("timeout");
	}
	const admitted = new Set(allowed);
	return rows.filter((row) => admitted.has(String(row.organizationId)));
}
