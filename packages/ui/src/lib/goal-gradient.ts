/**
 * Describe the next measurable goal without making the caller own the edge
 * cases around negative, fractional, or already-complete progress.
 *
 * The result is intentionally presentation-neutral. Waitlist and referral
 * surfaces can share the same math while choosing their own copy and action.
 */
export interface GoalGradient {
	complete: boolean;
	current: number;
	nearGoal: boolean;
	progressPercent: number;
	remaining: number;
	target: number | null;
}

function normalizedCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Find the smallest goal still ahead of the current count.
 *
 * A goal is "near" when one unit remains. That is the point where the product
 * should make the finish line most visible, without inventing a reward or a
 * queue-position guarantee.
 */
export function goalGradient(
	current: number,
	goals: readonly number[]
): GoalGradient {
	const count = normalizedCount(current);
	let target: number | null = null;

	for (const candidate of goals) {
		const normalizedTarget = normalizedCount(candidate);
		if (
			normalizedTarget <= count ||
			normalizedTarget === 0 ||
			(target !== null && normalizedTarget >= target)
		) {
			continue;
		}
		target = normalizedTarget;
	}

	if (target === null) {
		return {
			complete: true,
			current: count,
			nearGoal: false,
			progressPercent: 100,
			remaining: 0,
			target: null,
		};
	}

	const remaining = target - count;
	return {
		complete: false,
		current: count,
		nearGoal: remaining === 1,
		progressPercent: Math.min(100, Math.round((count / target) * 100)),
		remaining,
		target,
	};
}
