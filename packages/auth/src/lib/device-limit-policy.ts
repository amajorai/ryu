/**
 * Device-limit policy lookup and per-surface session counting.
 *
 * Whether an account's caps are enforced is a rollout decision (the
 * `auth.device_limits` flag) that `@ryu/api` resolves, and `@ryu/api` depends
 * on this package. So, like `registerCoreLimitsPlanResolver` in `plans.ts`,
 * the resolver is installed at boot into a single slot here.
 *
 * Sign-in must never fail because the policy could not be read: no resolver,
 * a thrown or rejected lookup, a null answer, or a lookup slower than the
 * timeout all mean "not enforced", and the sign-in is allowed.
 */
import {
	DEVICE_LIMIT_DEFAULTS,
	DEVICE_SURFACES,
	type DeviceLimitTable,
	type DeviceSurface,
} from "./device-limits.ts";
import { countSessionsBySurface } from "./device-surface.ts";

export interface DeviceLimitPolicy {
	/** True when new sign-ins over a cap are refused for this account. */
	enforced: boolean;
	limits: DeviceLimitTable;
}

export type DeviceLimitPolicyResolver = (input: {
	userId: string;
}) => Promise<DeviceLimitPolicy | null>;

let deviceLimitPolicyResolver: DeviceLimitPolicyResolver | null = null;

/** Install the device-limit policy resolver. Single slot, last wins. */
export function registerDeviceLimitPolicyResolver(
	implementation: DeviceLimitPolicyResolver | null
): void {
	deviceLimitPolicyResolver = implementation;
}

const DEVICE_LIMIT_POLICY_TIMEOUT_MS = 2000;
const POLICY_TIMED_OUT = Symbol("device-limit-policy-timeout");

/** The policy used whenever the real one cannot be read: never refuse. */
export const UNENFORCED_DEVICE_LIMIT_POLICY: DeviceLimitPolicy = Object.freeze({
	enforced: false,
	limits: DEVICE_LIMIT_DEFAULTS,
});

function sanitizeLimits(limits: unknown): DeviceLimitTable {
	const record =
		typeof limits === "object" && limits !== null
			? (limits as Record<string, unknown>)
			: {};
	const table = { ...DEVICE_LIMIT_DEFAULTS } as Record<DeviceSurface, number>;
	for (const surface of DEVICE_SURFACES) {
		const value = record[surface];
		if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
			table[surface] = value;
		}
	}
	return Object.freeze(table);
}

/**
 * The policy for `userId`. NEVER THROWS AND NEVER REJECTS: any failure,
 * timeout, or missing resolver yields the unenforced policy.
 */
export async function resolveDeviceLimitPolicy(
	userId: string,
	timeoutMs: number = DEVICE_LIMIT_POLICY_TIMEOUT_MS
): Promise<DeviceLimitPolicy> {
	const implementation = deviceLimitPolicyResolver;
	if (!(userId && implementation)) {
		return UNENFORCED_DEVICE_LIMIT_POLICY;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const policy = await Promise.race([
			implementation({ userId }),
			new Promise<typeof POLICY_TIMED_OUT>((resolve) => {
				timer = setTimeout(() => resolve(POLICY_TIMED_OUT), timeoutMs);
			}),
		]);
		if (policy === POLICY_TIMED_OUT) {
			console.error("[auth] device limits: policy lookup timed out");
			return UNENFORCED_DEVICE_LIMIT_POLICY;
		}
		if (policy?.enforced !== true) {
			return UNENFORCED_DEVICE_LIMIT_POLICY;
		}
		return { enforced: true, limits: sanitizeLimits(policy.limits) };
	} catch (error) {
		console.error("[auth] device limits: policy lookup failed:", error);
		return UNENFORCED_DEVICE_LIMIT_POLICY;
	} finally {
		clearTimeout(timer);
	}
}

/** Upper bound on session rows read for one account's count. */
export const DEVICE_LIMIT_SESSION_SCAN_LIMIT = 500;

/**
 * Reads up to `limit` LIVE session rows of `userId` (`expiresAt` after
 * `now`), newest first. Expired rows are filtered by the query, not after it,
 * so a pile of stale rows can never push live ones out of the bounded page.
 */
export type UserSessionFinder = (
	userId: string,
	limit: number,
	now: Date
) => Promise<unknown[]>;

/** One `where` clause of the adapter query (a subset of Better Auth's `Where`). */
export interface SessionWhereClause {
	field: string;
	operator?: "eq" | "gt";
	value: string | Date;
}

/** The slice of Better Auth's database adapter the count needs. */
export interface SessionFindManyAdapter {
	findMany: <T>(data: {
		limit?: number;
		model: string;
		sortBy?: { direction: "asc" | "desc"; field: string };
		where?: SessionWhereClause[];
	}) => Promise<T[]>;
}

/** A live-row finder over Better Auth's adapter (`ctx.context.adapter`). */
export function adapterSessionFinder(
	adapter: SessionFindManyAdapter
): UserSessionFinder {
	return (userId, limit, now) =>
		adapter.findMany<unknown>({
			limit,
			model: "session",
			sortBy: { direction: "desc", field: "createdAt" },
			where: [
				{ field: "userId", value: userId },
				{ field: "expiresAt", operator: "gt", value: now },
			],
		});
}

/** Live, non-impersonated sessions of `userId` per surface. */
export async function countUserSessionsBySurface(input: {
	findSessions: UserSessionFinder;
	now?: Date;
	userId: string;
}): Promise<Record<DeviceSurface, number>> {
	const now = input.now ?? new Date();
	const rows = await input.findSessions(
		input.userId,
		DEVICE_LIMIT_SESSION_SCAN_LIMIT,
		now
	);
	// The query already excludes expired rows; this also drops impersonated
	// ones and is a second guard should an adapter ignore the operator.
	return countSessionsBySurface(rows, now);
}

/**
 * Per-surface counts for `userId`, read exactly as enforcement reads them
 * (bounded, live rows only). `GET /api/sessions/device-limits` uses this so
 * the settings summary and the refusal never disagree.
 */
export function countLiveSessionsBySurfaceForUser(
	adapter: SessionFindManyAdapter,
	userId: string,
	now: Date = new Date()
): Promise<Record<DeviceSurface, number>> {
	return countUserSessionsBySurface({
		findSessions: adapterSessionFinder(adapter),
		now,
		userId,
	});
}
