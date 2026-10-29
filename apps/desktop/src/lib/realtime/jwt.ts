// apps/desktop/src/lib/realtime/jwt.ts
//
// Exchanges the desktop's control-plane (Better-Auth) SESSION token for a Core
// user-identity JWT, so a realtime room join can prove WHO the human is (Core
// verifies the JWT offline against the control plane's JWKS — see
// apps/core/src/identity_verify). The session token feeds `Authorization:
// Bearer` exactly like the marketplace buyer/credits clients; the JWT is the
// short-lived, JWKS-verifiable token that rides `?jwt=` on the realtime ws URL.
//
// NOTE on the endpoint: Better-Auth's `jwt()` plugin registers `/api/auth/token`
// as a GET (its docs show a headers-only `fetch`, and `authClient.token()` is a
// GET). We therefore call it with GET + `Authorization: Bearer <session>`, not
// POST. The route returns `{ token }`.
//
// The result is cached at module scope (one token shared across every room) and
// refreshed before its `exp`. Returns `null` when signed out so a room can still
// join anonymously (read-only / public access).

import { appRequestValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";

/** Seconds of headroom before a JWT's `exp` at which we treat it as stale and
 * force a refresh, so a token never expires mid-connection. */
const REFRESH_MARGIN_SECONDS = 60;

/** Fallback lifetime (seconds) when a token has no decodable `exp` claim. Kept
 * short because Better-Auth's default JWT TTL is ~15 minutes. */
const FALLBACK_TTL_SECONDS = 10 * 60;

/** Upper bound on one token exchange. Every authenticated Core request awaits
 * this JWT while building its headers, so a hung control plane must not stall
 * local Core calls for longer than this. */
const EXCHANGE_TIMEOUT_MS = 5000;

/** How long a failed exchange is remembered for the same session generation. A
 * revoked session or an auth outage otherwise turns every Core request into
 * its own `/api/auth/token` call. A new sign-in (a different session token)
 * or `clearRealtimeJwt()` retries immediately. */
const FAILURE_BACKOFF_SECONDS = 30;

interface SessionOwner {
	readonly sessionToken: string;
}

interface CachedJwt {
	/** Exact observed session generation that owns this minted JWT. */
	owner: SessionOwner;
	/** Unix epoch seconds at which this token should be considered stale. */
	staleAtSeconds: number;
	token: string;
}

/** The Better-Auth jwt-plugin token endpoint (a GET; see the file header). */
const TOKEN_ENDPOINT = `${BACKEND_URL.replace(/\/$/, "")}/api/auth/token`;

let currentOwner: SessionOwner | null = null;
let cached: CachedJwt | null = null;
/** Same-owner callers share an exchange; retired owners keep no current slot. */
interface InFlightJwt {
	owner: SessionOwner;
	promise: Promise<string | null>;
}
let inFlight: InFlightJwt | null = null;
/** The last failed exchange, so callers stay anonymous until `retryAtSeconds`
 * instead of re-hitting the token endpoint on every request. Owned by one
 * session generation; a new generation starts without it. */
let failedExchange: { owner: SessionOwner; retryAtSeconds: number } | null =
	null;

/** Read the control-plane session token, or `null` when signed out. */
function readSessionToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		return null;
	}
}

/** Observe token changes without treating a returned token as its old generation. */
function observeSessionOwner(): SessionOwner | null {
	const sessionToken = readSessionToken();
	if (!sessionToken) {
		currentOwner = null;
		cached = null;
		inFlight = null;
		failedExchange = null;
	} else if (currentOwner?.sessionToken !== sessionToken) {
		currentOwner = { sessionToken };
		cached = null;
		inFlight = null;
		failedExchange = null;
	}
	return currentOwner;
}

function isCurrentOwner(owner: SessionOwner): boolean {
	return observeSessionOwner() === owner;
}

// JWT claims are native JSON. Only these three claims are consumed here; keep
// their raw values until the individual claim is refined, including id/sub
// precedence when a malformed id accompanies a valid subject.
const jwtClaimsProjectionSchema = z.object({
	exp: appRequestValueSchema.optional(),
	id: appRequestValueSchema.optional(),
	sub: appRequestValueSchema.optional(),
});
const jwtExpirationSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const jwtSubjectSchema = z.string().min(1);
const jwtTokenResponseSchema = z.object({ token: z.string() });

/**
 * Decode a JWT payload (the middle segment is base64url-encoded JSON) without a
 * crypto library. Returns `null` when the token is malformed. This is NOT a
 * verification — it only reads claims a trusted caller already minted; Core
 * re-verifies the signature offline.
 */
function readJwtClaims(token: string) {
	const segments = token.split(".");
	if (segments.length < 2) {
		return null;
	}
	try {
		const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
		const parsed = jwtClaimsProjectionSchema.safeParse(
			JSON.parse(atob(base64))
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Decode a JWT's `exp` (seconds since epoch). Returns `null` when the token is
 * malformed or carries no numeric `exp`.
 */
function readJwtExpSeconds(token: string): number | null {
	const claims = readJwtClaims(token);
	const parsed = jwtExpirationSchema.safeParse(claims?.exp);
	return parsed.success ? parsed.data : null;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** Build the cache entry (token + computed stale-at) for a freshly-minted JWT. */
function toCacheEntry(token: string, owner: SessionOwner): CachedJwt {
	const exp = readJwtExpSeconds(token);
	const staleAtSeconds =
		exp === null
			? nowSeconds() + FALLBACK_TTL_SECONDS
			: exp - REFRESH_MARGIN_SECONDS;
	return { token, owner, staleAtSeconds };
}

/** Hit `{BACKEND_URL}/api/auth/token` with the session bearer and return the
 * minted JWT, or `null` on any failure or timeout (the room falls back to
 * anonymous). */
async function exchange(sessionToken: string): Promise<string | null> {
	try {
		const resp = await fetch(TOKEN_ENDPOINT, {
			headers: { Authorization: `Bearer ${sessionToken}` },
			signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
		});
		if (!resp.ok) {
			return null;
		}
		const body = jwtTokenResponseSchema.safeParse(await resp.json());
		return body.success ? body.data.token : null;
	} catch {
		return null;
	}
}

/**
 * Return a valid Core JWT for the current session, minting/refreshing as needed.
 * Returns `null` when signed out (anonymous join). Concurrent calls share one
 * in-flight exchange; the result is cached until shortly before it expires, and
 * a failure is remembered for `FAILURE_BACKOFF_SECONDS` per session generation.
 */
export async function getRealtimeJwt(): Promise<string | null> {
	const owner = observeSessionOwner();
	if (!owner) {
		return null;
	}
	const fresh =
		cached !== null &&
		cached.owner === owner &&
		cached.staleAtSeconds > nowSeconds();
	if (fresh && cached) {
		return cached.token;
	}
	if (
		failedExchange?.owner === owner &&
		failedExchange.retryAtSeconds > nowSeconds()
	) {
		return null;
	}
	let flight = inFlight;
	if (!flight || flight.owner !== owner) {
		flight = {
			owner,
			promise: exchange(owner.sessionToken).then((token) => {
				if (!isCurrentOwner(owner)) {
					return null;
				}
				cached = token === null ? null : toCacheEntry(token, owner);
				failedExchange =
					token === null
						? {
								owner,
								retryAtSeconds: nowSeconds() + FAILURE_BACKOFF_SECONDS,
							}
						: null;
				return token;
			}),
		};
		inFlight = flight;
	}
	try {
		const token = await flight.promise;
		return isCurrentOwner(owner) ? token : null;
	} finally {
		if (inFlight === flight) {
			inFlight = null;
		}
	}
}

/**
 * The current human's stable Core user id (the JWT `id`/`sub` claim — the exact
 * value Core stamps as a message's `author_user_id`). Mints/refreshes the JWT as
 * needed, then decodes its subject. Returns `null` when signed out (anonymous).
 *
 * Mirrors Core's `claims.id.or(claims.sub)` precedence (see
 * apps/core/src/identity_verify) so a realtime surface can tell "my own message"
 * from "someone else's" by comparing `author_user_id` against this value.
 */
export async function getRealtimeUserId(): Promise<string | null> {
	const owner = observeSessionOwner();
	if (!owner) {
		return null;
	}
	const token = await getRealtimeJwt();
	if (!(token && isCurrentOwner(owner))) {
		return null;
	}
	const claims = readJwtClaims(token);
	if (!claims) {
		return null;
	}
	const id = claims.id ?? claims.sub;
	const parsed = jwtSubjectSchema.safeParse(id);
	return parsed.success ? parsed.data : null;
}

/**
 * Retire the current JWT generation and any failure backoff so the next call
 * re-mints, e.g. on explicit sign-out or after an org switch: the token's
 * signed `ryu_flags`/`ryu_flags_org` claims are evaluated for the session's
 * active org at mint time, and Better Auth's `set-active` does not rotate the
 * session token, so without this a node bound to the new org would keep
 * receiving a claim made for the old one until the token goes stale. An
 * exchange already in flight belongs to the retired generation, so its result
 * is neither cached nor returned.
 */
export function clearRealtimeJwt(): void {
	currentOwner = null;
	cached = null;
	inFlight = null;
	failedExchange = null;
}
