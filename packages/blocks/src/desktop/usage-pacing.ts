import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { UsageWindowTarget } from "./monitor-types.ts";

const MIN_WINDOW_AGE_MS = 5 * 60 * 1000;
const MS_PER_SECOND = 1000;

export type UsagePacingEstimate =
	| { kind: "at-limit" }
	| { kind: "no-usage" }
	| { kind: "warming-up" }
	| { kind: "unavailable" }
	| { kind: "before-reset"; limitAt: number; resetsAt: number }
	| { kind: "reset-first"; projectedUseAtReset: number; resetsAt: number };

/** The fields pacing reads, so any provider-reported window shape can use it. */
export type UsagePacingWindow = Pick<
	UsageWindowTarget,
	"resetsAt" | "usedPercent" | "windowSeconds"
>;

/**
 * Project a quota window from its average use since the reported window start.
 * Providers that omit either the window length or reset time cannot be forecast.
 */
export function estimateUsagePacing(
	window: UsagePacingWindow,
	now = Date.now()
): UsagePacingEstimate {
	const usedPercent = window.usedPercent;
	if (!Number.isFinite(usedPercent) || usedPercent < 0) {
		return { kind: "unavailable" };
	}
	if (usedPercent >= 100) {
		return { kind: "at-limit" };
	}
	if (usedPercent === 0) {
		return { kind: "no-usage" };
	}

	const windowSeconds = window.windowSeconds;
	const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
	if (
		!(isNativeNumber(windowSeconds) && Number.isFinite(windowSeconds)) ||
		windowSeconds <= 0 ||
		!Number.isFinite(resetsAt) ||
		resetsAt <= now
	) {
		return { kind: "unavailable" };
	}

	const windowStartedAt = resetsAt - windowSeconds * MS_PER_SECOND;
	const elapsedMs = now - windowStartedAt;
	if (elapsedMs < MIN_WINDOW_AGE_MS) {
		return { kind: "warming-up" };
	}

	const usagePerMs = usedPercent / elapsedMs;
	const timeToLimitMs = (100 - usedPercent) / usagePerMs;
	const limitAt = now + timeToLimitMs;
	if (limitAt < resetsAt) {
		return { kind: "before-reset", limitAt, resetsAt };
	}

	const projectedUseAtReset = Math.min(
		100,
		usedPercent + usagePerMs * (resetsAt - now)
	);
	return { kind: "reset-first", projectedUseAtReset, resetsAt };
}
