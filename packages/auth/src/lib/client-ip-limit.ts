import { createHash } from "node:crypto";
import { getIP } from "@better-auth/core/utils/ip";
import { IpRequestLimit } from "@ryu/db/models/ip-request-limit.model";
import { isDuplicateKeyError } from "@ryu/db/native-duplicate-key";
import type { BetterAuthOptions } from "better-auth";

// A per-client-IP request limit for signed-out endpoints that take an email
// address and live outside Better Auth (so its own limiter never sees them).
// The client IP is resolved exactly as Better Auth's limiter resolves it: its
// own `getIP` over the same `advanced.ipAddress` options (forwarded headers,
// trusted proxies, IPv6 subnet). A request whose IP cannot be resolved shares
// one bucket (`NO_TRUSTED_IP_KEY`). That differs from Better Auth in one case:
// with `advanced.ipAddress.disableIpTracking` set, Better Auth skips its limit
// entirely, while this limiter still limits through the shared bucket (the
// option is not set in this app). The key is the IP only, never the address,
// so the answer cannot depend on whether an account exists.
//
// The windows live in Mongo (`ipRequestLimit`), so the limit holds across
// replicas. Each window is fixed (one row per scope, IP and window start),
// not sliding: a burst straddling a window boundary can reach twice `max`.

/** The bucket for a request with no trustworthy client IP (Better Auth's). */
export const NO_TRUSTED_IP_KEY = "no-trusted-ip";

export interface IpLimitRule {
	max: number;
	windowMs: number;
}

export type IpLimitResult =
	| { allowed: true }
	| { allowed: false; retryAfter: number };

/** The client IP Better Auth's limiter would use, or the shared bucket. */
export function limitIp(
	request: Request | Headers,
	options: Pick<BetterAuthOptions, "advanced">
): string {
	return getIP(request, options as BetterAuthOptions) ?? NO_TRUSTED_IP_KEY;
}

function windowKey(scope: string, ip: string, windowStart: number): string {
	const digest = createHash("sha256").update(`${scope}:${ip}`).digest("hex");
	return `${digest}:${windowStart}`;
}

/**
 * One conditional upsert: increments the window's row while it is below
 * `max`, inserts it if absent. True when admitted, false on a duplicate key
 * (the row exists but the filter missed it). Other store errors propagate.
 */
async function incrementWindow(
	key: string,
	max: number,
	windowEnd: number
): Promise<boolean> {
	try {
		const row = await IpRequestLimit.findOneAndUpdate(
			{ _id: key, count: { $lt: max } },
			{
				$inc: { count: 1 },
				$setOnInsert: { expiresAt: new Date(windowEnd) },
			},
			{ new: true, upsert: true }
		);
		return row !== null;
	} catch (error) {
		if (isDuplicateKeyError(error)) {
			return false;
		}
		throw error;
	}
}

/**
 * Claim one request for `ip` in `scope`'s current fixed window. A conditional
 * upsert decides it, so concurrent requests cannot exceed `rule.max`: a full
 * window misses the filter and its insert collides with the stored row
 * (duplicate key, a refusal). The server does not retry that duplicate key
 * for us, because the filter is not all equality (`count: { $lt: max }`), so
 * two first requests racing to insert the same row would refuse the loser.
 * A duplicate key is therefore retried once: the row exists by then, so the
 * retry either increments it or misses the filter and is refused. The
 * concurrency tests pin both. Store errors propagate; the caller decides.
 */
export async function claimIpRequest(
	scope: string,
	ip: string,
	rule: IpLimitRule,
	now = Date.now()
): Promise<IpLimitResult> {
	const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
	const windowEnd = windowStart + rule.windowMs;
	const key = windowKey(scope, ip, windowStart);
	if (
		(await incrementWindow(key, rule.max, windowEnd)) ||
		(await incrementWindow(key, rule.max, windowEnd))
	) {
		return { allowed: true };
	}
	return {
		allowed: false,
		retryAfter: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
	};
}
