import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
/**
 * Elapsed-time rule for an ACP turn's footer meter.
 *
 * Its own module rather than a function inside `message-stats.tsx` so it can be
 * unit-tested: anything importing `@ryu/ui` components cannot be resolved by the
 * test runner, and this rule is the part with the interesting behaviour.
 */

/**
 * The elapsed time an ACP turn's footer should show, or null for "no duration".
 *
 * A turn is TERMINAL when Core sealed it (`done`) or when it is no longer the
 * live one (`isLive` false — the chat has gone back to ready, or this is an old
 * turn being read back). Terminal is deliberately not the same as "finalized":
 * a turn interrupted by Stop, an error, or a Core restart never receives its
 * `done:true` frame, and treating that as still-running is what made the meter
 * count up forever — and restart from zero on every reload.
 *
 * Terminal turns prefer Core's finalized `durationMs`, fall back to the last
 * value measured while the turn WAS live (`frozenMs`), and otherwise show
 * nothing rather than a fabricated one.
 */
export function resolveAcpElapsedMs({
	done,
	durationMs,
	frozenMs,
	isLive,
	now,
	startedAt,
}: {
	done?: boolean;
	durationMs?: number;
	/** Last live measurement, so an interrupted turn freezes instead of blanking. */
	frozenMs: number | null;
	isLive: boolean;
	now: number;
	startedAt: number | null;
}): number | null {
	const isTerminal = done === true || !isLive;
	if (isTerminal) {
		if (isNativeNumber(durationMs)) {
			return durationMs;
		}
		return frozenMs;
	}
	if (startedAt === null) {
		return null;
	}
	return Math.max(0, now - startedAt);
}
