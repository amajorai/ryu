/** Native property access owns primitive receiver and getter semantics. */
export function readStatsEnvironmentSlot(receiver, key) {
	return receiver[key];
}
