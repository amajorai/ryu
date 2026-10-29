// Native usage operations retain provider operands, inherited getters, coercion order and throws.
export function readContextField(receiver, key) {
	return receiver[key];
}
export function sumContextTokens(prompt, completion) {
	return (prompt ?? 0) + (completion ?? 0);
}
export function isPositiveContextCount(value) {
	return value > 0;
}
export function isNonPositiveContextCount(value) {
	return value <= 0;
}
export function nativeContextPct(used, total) {
	return (used / total) * 100;
}
// Lazy operand readers preserve the native Math.max lookup before caller field getters.
export function nativeContextRemaining(total, used) {
	return Math.max(0, total() - used());
}
export function nativeContextMax(left, right) {
	return Math.max(left(), right());
}
