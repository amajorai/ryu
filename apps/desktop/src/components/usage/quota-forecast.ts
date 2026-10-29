import {
	estimateUsagePacing,
	type UsagePacingEstimate,
} from "@ryu/blocks/desktop/usage-pacing.ts";
import type { SubscriptionUsageAccount } from "@/src/hooks/useSubscriptionUsage.ts";
import type { UsageWindow } from "@/src/lib/api/usage.ts";

export interface WindowProjection {
	estimate: UsagePacingEstimate;
	/** Percent of the window still left when it resets at the current pace. */
	remainingAtReset: number | null;
}

export interface AccountQuotaForecast {
	/** A window is already exhausted. */
	atLimit: boolean;
	/** Earliest projected exhaustion across windows that run out before reset. */
	limitAt: number | null;
	/** The tightest window's projected headroom at its reset. */
	remainingAtReset: number | null;
	/** The tightest window's current headroom. */
	remainingNow: number | null;
}

export interface PoolQuotaForecast {
	/** Accounts already at a limit or whose pace exhausts one before reset. */
	atRisk: number;
	/** Accounts with at least one forecastable window. */
	forecastable: number;
	/** Mean projected headroom at reset across forecastable accounts. */
	remainingAtReset: number | null;
	/** Mean current headroom across forecastable accounts. */
	remainingNow: number | null;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

export function projectWindow(
	window: UsageWindow,
	now = Date.now()
): WindowProjection {
	const estimate = estimateUsagePacing(window, now);
	switch (estimate.kind) {
		case "at-limit":
		case "before-reset":
			return { estimate, remainingAtReset: 0 };
		case "reset-first":
			return {
				estimate,
				remainingAtReset: clampPercent(100 - estimate.projectedUseAtReset),
			};
		case "no-usage":
			return { estimate, remainingAtReset: 100 };
		default:
			return { estimate, remainingAtReset: null };
	}
}

export function forecastAccountQuota(
	account: SubscriptionUsageAccount,
	now = Date.now()
): AccountQuotaForecast | null {
	const snapshot = account.snapshot;
	if (!snapshot?.available || snapshot.windows.length === 0) {
		return null;
	}
	let atLimit = false;
	let limitAt: number | null = null;
	let remainingAtReset: number | null = null;
	let remainingNow: number | null = null;
	for (const window of snapshot.windows) {
		const projection = projectWindow(window, now);
		if (projection.remainingAtReset === null) {
			continue;
		}
		atLimit ||= projection.estimate.kind === "at-limit";
		if (projection.estimate.kind === "before-reset") {
			limitAt = Math.min(
				limitAt ?? Number.POSITIVE_INFINITY,
				projection.estimate.limitAt
			);
		}
		remainingAtReset = Math.min(
			remainingAtReset ?? 100,
			projection.remainingAtReset
		);
		remainingNow = Math.min(
			remainingNow ?? 100,
			clampPercent(100 - window.usedPercent)
		);
	}
	return remainingAtReset === null
		? null
		: { atLimit, limitAt, remainingAtReset, remainingNow };
}

export function forecastQuotaPool(
	accounts: readonly SubscriptionUsageAccount[],
	now = Date.now()
): PoolQuotaForecast {
	let atRisk = 0;
	let forecastable = 0;
	let remainingAtReset = 0;
	let remainingNow = 0;
	for (const account of accounts) {
		const forecast = forecastAccountQuota(account, now);
		if (!forecast) {
			continue;
		}
		forecastable += 1;
		remainingAtReset += forecast.remainingAtReset ?? 0;
		remainingNow += forecast.remainingNow ?? 0;
		if (forecast.atLimit || forecast.limitAt !== null) {
			atRisk += 1;
		}
	}
	return {
		atRisk,
		forecastable,
		remainingAtReset: forecastable > 0 ? remainingAtReset / forecastable : null,
		remainingNow: forecastable > 0 ? remainingNow / forecastable : null,
	};
}

/** "45m" / "3h 10m" / "2d 4h" until `at`, for pace projections. */
export function formatTimeUntil(at: number, now = Date.now()): string {
	const minutes = Math.max(1, Math.round((at - now) / 60_000));
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}
