import { z } from "zod";
export const STALE_ACCOUNT_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns true only when a prior login is old enough to be a dormant-account alert. */
export function isStaleAccountLogin(
	lastLoginAt: Date | null | undefined,
	now = new Date()
): boolean {
	if (!(lastLoginAt instanceof Date) || Number.isNaN(lastLoginAt.getTime())) {
		return false;
	}
	return now.getTime() - lastLoginAt.getTime() >= STALE_ACCOUNT_DAYS * DAY_MS;
}

/** Whole inactive days used in the user/admin notification copy. */
export function daysSinceLastActive(
	lastLoginAt: Date,
	now = new Date()
): number {
	return Math.max(
		STALE_ACCOUNT_DAYS,
		Math.floor((now.getTime() - lastLoginAt.getTime()) / DAY_MS)
	);
}

/** Stable, timezone-explicit display text for an authentication alert. */
export function formatLoginTime(value: Date): string {
	const date = value.toLocaleDateString("en-US", {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
		year: "numeric",
	});
	const time = value.toLocaleTimeString("en-US", {
		hour: "numeric",
		hour12: true,
		minute: "2-digit",
		timeZone: "UTC",
	});
	return `${date} at ${time} UTC`;
}

/** Bound request-derived device/IP text before it reaches an email. */
export const boundedLoginDetail = z
	.string()
	.trim()
	.transform((value) => (value.length > 0 ? value.slice(0, 200) : undefined))
	.optional()
	.catch(undefined).parse;
