// apps/desktop/src/lib/crash-recovery.ts
//
// The retry policy behind CrashBoundary's bounded self-recovery. Kept as a pure
// module (no React, no DOM, no env reads) so the part that must never regress —
// the BUDGET — is unit-testable on its own.
//
// Why a budget at all: the crash this exists for is React's "Maximum update depth
// exceeded", i.e. a render loop. Remounting the failed subtree fixes the transient
// cases (a stale prop, a one-off bad payload) but re-enters the loop for a real
// one, so an unbounded retry would spin forever and burn the user's battery while
// showing them nothing. Every retry is therefore spent from a fixed budget, and
// when it runs out the terminal error UI renders and stays.
//
// An "episode" is one crash and everything that follows from it. A later, unrelated
// crash must get its own full budget — otherwise a single early hiccup permanently
// disarms recovery for the rest of the session — so an episode ends when the user
// moves to a different route, or when the boundary has rendered cleanly for
// STABLE_RENDER_MS (see CrashBoundary.confirmRecovered).

/** How many automatic remounts one episode may spend. Small on purpose. */
export const MAX_AUTO_RETRIES = 2;

/**
 * Backoff before each automatic remount, indexed by attempt number - 1. Short: the
 * user is staring at a placeholder for the whole window, and the worst case
 * (every retry spent, then the terminal UI) must still feel like a hitch rather
 * than a hang — here 0.3s + 1.2s = 1.5s.
 */
export const RETRY_BACKOFF_MS = [
	300, 1200,
] as const satisfies readonly number[];

/**
 * How long the boundary must render its children without throwing before the
 * episode counts as recovered and the budget is refunded. Long enough that a
 * render loop — which re-throws within a frame or two — can never clear it.
 */
export const STABLE_RENDER_MS = 10_000;

export interface RecoveryEpisode {
	/** Automatic remounts spent so far in this episode. */
	autoRetries: number;
	/** Remounts the user asked for explicitly (each one refunds the auto budget). */
	manualRetries: number;
	/** Where the episode started; a different route starts a fresh episode. */
	routeKey: string | null;
}

export type RecoveryDecision =
	| { kind: "retry"; attempt: number; delayMs: number }
	| { kind: "terminal"; reason: "budget-exhausted" | "auto-retry-disabled" };

export interface RecoveryPlan {
	decision: RecoveryDecision;
	episode: RecoveryEpisode;
}

function freshEpisode(routeKey: string | null): RecoveryEpisode {
	return { autoRetries: 0, manualRetries: 0, routeKey };
}

/**
 * Decide what to do about a freshly caught error.
 *
 * `previous` is the episode in flight (null when this is the first crash since the
 * last recovery). `autoRetryEnabled` is the caller's kill switch — CrashBoundary
 * passes false in dev builds so a render loop stays loud for the developer instead
 * of being quietly papered over.
 */
export function planRecovery(
	previous: RecoveryEpisode | null,
	options: { autoRetryEnabled: boolean; routeKey: string | null }
): RecoveryPlan {
	const { autoRetryEnabled, routeKey } = options;
	// A crash somewhere else is a different bug: give it its own budget.
	const continuing =
		previous && previous.routeKey === routeKey
			? previous
			: freshEpisode(routeKey);

	if (!autoRetryEnabled) {
		return {
			decision: { kind: "terminal", reason: "auto-retry-disabled" },
			episode: continuing,
		};
	}
	if (continuing.autoRetries >= MAX_AUTO_RETRIES) {
		return {
			decision: { kind: "terminal", reason: "budget-exhausted" },
			episode: continuing,
		};
	}

	const attempt = continuing.autoRetries + 1;
	const delayMs = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1) ?? 0;
	return {
		decision: { kind: "retry", attempt, delayMs },
		episode: { ...continuing, autoRetries: attempt },
	};
}

/**
 * The user pressed "Try again" on the terminal screen. That is an explicit ask, so
 * it refunds the automatic budget — but it is still counted, so the Sentry report
 * for a crash that only settled after three manual clicks doesn't read as a clean
 * first-try recovery.
 */
export function recordManualRetry(
	previous: RecoveryEpisode | null,
	routeKey: string | null
): RecoveryEpisode {
	const base =
		previous && previous.routeKey === routeKey
			? previous
			: freshEpisode(routeKey);
	return { ...base, autoRetries: 0, manualRetries: base.manualRetries + 1 };
}

/**
 * Whether an episode did anything worth reporting once it settled. A type guard so
 * the caller can read the counts off it afterwards without a second null check.
 */
export function episodeDidRecover(
	episode: RecoveryEpisode | null
): episode is RecoveryEpisode {
	return Boolean(
		episode && (episode.autoRetries > 0 || episode.manualRetries > 0)
	);
}

/** Shallow compare for the `resetKeys` prop (undefined on both sides = unchanged). */
export function resetKeysChanged(
	a: readonly unknown[] | undefined,
	b: readonly unknown[] | undefined
): boolean {
	if (a === b) {
		return false;
	}
	if (!(a && b) || a.length !== b.length) {
		return true;
	}
	return a.some((value, index) => !Object.is(value, b[index]));
}
