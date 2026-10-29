// packages/core-client/src/user-jwt.ts
//
// A cached source for the short-lived Better Auth user JWT that a shared Core
// node verifies offline to learn WHICH member is calling (see
// apps/core/src/identity_verify). Every surface needs the same caching, refresh
// and single-flight behavior; only the exchange differs:
//
//   - surfaces with their own cloud session (desktop, native, extension) trade
//     that session at the control plane's `GET /api/auth/token`;
//   - surfaces without one (CLI, Island, Raycast) ask their LOCAL Core, which
//     holds the signed-in account and brokers the exchange at
//     `GET /api/auth/user-jwt` (served to trusted local peers only).
//
// `current()` is synchronous so it can feed `setUserJwtProvider`, whose header
// builder runs synchronously. Call `refresh()` once at startup and whenever a
// request is about to go out; it is a no-op while the cached token is fresh.

import { z } from "zod";
import { type ApiTarget, apiUrl, fetchForTarget } from "./client.ts";

/** Seconds of headroom before `exp` at which a cached token is refreshed. */
const REFRESH_MARGIN_SECONDS = 60;

/** Lifetime assumed for a token whose `exp` cannot be read (Better Auth's
 * default is fifteen minutes, so stay well inside it). */
const FALLBACK_TTL_SECONDS = 5 * 60;

/** Deadline for one exchange, so a hung endpoint cannot pin the single flight. */
const EXCHANGE_TIMEOUT_MS = 10_000;

/** One exchange result: the token and its expiry in Unix seconds, if known. */
export interface MintedUserJwt {
	expiresAt: number | null;
	token: string;
}

/** Performs one exchange. Resolves `null` when signed out or unavailable. */
export type UserJwtExchange = () => Promise<MintedUserJwt | null>;

export interface UserJwtSource {
	/** Forget the token and invalidate pending exchanges, for example after sign-out. */
	clear(): void;
	/** The cached token while it is fresh, otherwise `null`. Synchronous. */
	current(): string | null;
	/** Refresh when stale and resolve the fresh token (or `null`). */
	refresh(): Promise<string | null>;
}

export interface UserJwtSourceOptions {
	exchange: UserJwtExchange;
	/** After an exchange yields no token, `refresh()` resolves `null` without
	 * exchanging again until this many milliseconds pass or `clear()` runs.
	 * Defaults to 0: the next `refresh()` retries at once. */
	failureBackoffMs?: number;
	/** Clock in Unix milliseconds; injectable for tests. */
	now?: () => number;
}

/** Optional deadline override for one exchange request; tests shorten it. */
interface ExchangeTimeoutOption {
	timeoutMs?: number;
}

const jwtExpirySchema = z.object({ exp: z.number().nullable().catch(null) });
const mintedUserJwtSchema = z.object({
	token: z.string().min(1),
	expiresAt: z.number().nullable().catch(null),
});

/** Read `exp` (Unix seconds) from a JWT payload without verifying it. Core
 * re-verifies every token it receives; this only schedules the refresh. */
export function readJwtExpiry(token: string): number | null {
	const segments = token.split(".");
	if (segments.length !== 3 || !segments[1]) {
		return null;
	}
	try {
		const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const claims = jwtExpirySchema.safeParse(JSON.parse(atob(padded)));
		return claims.success ? claims.data.exp : null;
	} catch {
		return null;
	}
}

export function createUserJwtSource(
	options: UserJwtSourceOptions
): UserJwtSource {
	const now = options.now ?? Date.now;
	const failureBackoffMs = options.failureBackoffMs ?? 0;
	let cached: { staleAt: number; token: string } | null = null;
	let inFlight: Promise<string | null> | null = null;
	let generation = 0;
	/** Unix ms before which a failed exchange is not retried. */
	let retryAt = 0;

	const nowSeconds = (): number => Math.floor(now() / 1000);

	const current = (): string | null => {
		if (cached && cached.staleAt > nowSeconds()) {
			return cached.token;
		}
		return null;
	};

	const exchangeOnce = async (
		exchangeGeneration: number
	): Promise<string | null> => {
		let minted: MintedUserJwt | null = null;
		try {
			minted = await options.exchange();
		} catch {
			minted = null;
		}
		if (exchangeGeneration !== generation) {
			return null;
		}
		if (!minted?.token) {
			cached = null;
			retryAt = now() + failureBackoffMs;
			return null;
		}
		retryAt = 0;
		const expiresAt =
			minted.expiresAt ??
			readJwtExpiry(minted.token) ??
			nowSeconds() + FALLBACK_TTL_SECONDS;
		cached = {
			staleAt: expiresAt - REFRESH_MARGIN_SECONDS,
			token: minted.token,
		};
		return minted.token;
	};

	const refresh = async (): Promise<string | null> => {
		const fresh = current();
		if (fresh) {
			return fresh;
		}
		if (!inFlight) {
			// Bound the wait by the window itself, so a wall clock stepped back
			// cannot stretch one failed exchange into a long anonymous stretch.
			const wait = retryAt - now();
			if (wait > 0 && wait <= failureBackoffMs) {
				return null;
			}
			const exchangeGeneration = generation;
			inFlight = exchangeOnce(exchangeGeneration).finally(() => {
				if (exchangeGeneration === generation) {
					inFlight = null;
				}
			});
		}
		return await inFlight;
	};

	return {
		clear: () => {
			generation += 1;
			inFlight = null;
			cached = null;
			retryAt = 0;
		},
		current,
		refresh,
	};
}

/** Exchange a Better Auth session token at the control plane. */
export function sessionUserJwtExchange(
	input: {
		backendUrl: string;
		fetch?: ApiTarget["fetch"];
		sessionToken: () => string | null;
	} & ExchangeTimeoutOption
): UserJwtExchange {
	return async () => {
		const sessionToken = input.sessionToken();
		if (!sessionToken) {
			return null;
		}
		const endpoint = `${input.backendUrl.replace(/\/$/, "")}/api/auth/token`;
		const response = await fetchForTarget(input)(endpoint, {
			headers: { Authorization: `Bearer ${sessionToken}` },
			signal: AbortSignal.timeout(input.timeoutMs ?? EXCHANGE_TIMEOUT_MS),
		});
		if (!response.ok) {
			return null;
		}
		const body = mintedUserJwtSchema.safeParse(await response.json());
		return body.success ? { expiresAt: null, token: body.data.token } : null;
	};
}

/** Ask a LOCAL Core to mint the signed-in account's JWT. */
export function coreBrokeredUserJwtExchange(
	localCore: Pick<ApiTarget, "fetch" | "token" | "url"> & ExchangeTimeoutOption
): UserJwtExchange {
	return async () => {
		const headers = new Headers({ Accept: "application/json" });
		if (localCore.token) {
			headers.set("Authorization", `Bearer ${localCore.token}`);
		}
		const response = await fetchForTarget(localCore)(
			apiUrl(
				{ token: localCore.token, url: localCore.url },
				"/api/auth/user-jwt"
			),
			{
				headers,
				signal: AbortSignal.timeout(localCore.timeoutMs ?? EXCHANGE_TIMEOUT_MS),
			}
		);
		if (!response.ok) {
			return null;
		}
		const body = mintedUserJwtSchema.safeParse(await response.json());
		return body.success ? body.data : null;
	};
}

/** Whether a Core URL points at this machine, where the local Core can broker. */
export function isLoopbackCoreUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
		return (
			host === "localhost" ||
			host === "::1" ||
			/^127(?:\.\d{1,3}){3}$/.test(host)
		);
	} catch {
		return false;
	}
}
