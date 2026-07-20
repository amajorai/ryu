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

import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

/** Seconds of headroom before a JWT's `exp` at which we treat it as stale and
 * force a refresh, so a token never expires mid-connection. */
const REFRESH_MARGIN_SECONDS = 60;

/** Fallback lifetime (seconds) when a token has no decodable `exp` claim. Kept
 * short because Better-Auth's default JWT TTL is ~15 minutes. */
const FALLBACK_TTL_SECONDS = 10 * 60;

interface CachedJwt {
	/** The control-plane session token this JWT was minted from. Cache is
	 * invalidated when the session token changes (sign-out / account switch). */
	sessionToken: string;
	/** Unix epoch seconds at which this token should be considered stale. */
	staleAtSeconds: number;
	token: string;
}

/** The Better-Auth jwt-plugin token endpoint (a GET; see the file header). */
const TOKEN_ENDPOINT = `${BACKEND_URL.replace(/\/$/, "")}/api/auth/token`;

let cached: CachedJwt | null = null;
/** Single-flight guard: concurrent callers await one in-flight exchange. */
let inFlight: Promise<string | null> | null = null;

/** Read the control-plane session token, or `null` when signed out. */
function readSessionToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

/**
 * Decode a JWT payload (the middle segment is base64url-encoded JSON) without a
 * crypto library. Returns `null` when the token is malformed. This is NOT a
 * verification — it only reads claims a trusted caller already minted; Core
 * re-verifies the signature offline.
 */
function readJwtClaims(token: string): Record<string, unknown> | null {
	const segments = token.split(".");
	if (segments.length < 2) {
		return null;
	}
	try {
		const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
		return JSON.parse(atob(base64)) as Record<string, unknown>;
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
	return claims && typeof claims.exp === "number" ? claims.exp : null;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** Build the cache entry (token + computed stale-at) for a freshly-minted JWT. */
function toCacheEntry(token: string, sessionToken: string): CachedJwt {
	const exp = readJwtExpSeconds(token);
	const staleAtSeconds =
		exp === null
			? nowSeconds() + FALLBACK_TTL_SECONDS
			: exp - REFRESH_MARGIN_SECONDS;
	return { token, sessionToken, staleAtSeconds };
}

/** Hit `{BACKEND_URL}/api/auth/token` with the session bearer and return the
 * minted JWT, or `null` on any failure (the room falls back to anonymous). */
async function exchange(sessionToken: string): Promise<string | null> {
	try {
		const resp = await fetch(TOKEN_ENDPOINT, {
			headers: { Authorization: `Bearer ${sessionToken}` },
		});
		if (!resp.ok) {
			return null;
		}
		const body = (await resp.json()) as { token?: unknown };
		return typeof body.token === "string" ? body.token : null;
	} catch {
		return null;
	}
}

/**
 * Return a valid Core JWT for the current session, minting/refreshing as needed.
 * Returns `null` when signed out (anonymous join). Concurrent calls share one
 * in-flight exchange; the result is cached until shortly before it expires.
 */
export async function getRealtimeJwt(): Promise<string | null> {
	const sessionToken = readSessionToken();
	if (!sessionToken) {
		cached = null;
		return null;
	}
	const fresh =
		cached !== null &&
		cached.sessionToken === sessionToken &&
		cached.staleAtSeconds > nowSeconds();
	if (fresh && cached) {
		return cached.token;
	}
	if (inFlight) {
		return inFlight;
	}
	inFlight = (async () => {
		const token = await exchange(sessionToken);
		cached = token === null ? null : toCacheEntry(token, sessionToken);
		return token;
	})();
	try {
		return await inFlight;
	} finally {
		inFlight = null;
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
	const token = await getRealtimeJwt();
	if (!token) {
		return null;
	}
	const claims = readJwtClaims(token);
	if (!claims) {
		return null;
	}
	const id = claims.id ?? claims.sub;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/** Drop the cached JWT (e.g. on explicit sign-out) so the next call re-mints. */
export function clearRealtimeJwt(): void {
	cached = null;
}
