/** Native optional member access. Preserve primitive boxing, inherited getters,
 * their original receiver, property-key coercion, and nullish short-circuiting.
 * This observes a live property; it does not validate a part or metadata DTO. */
export function observeNativeOptionalProperty(receiver, key) {
	return receiver?.[key];
}
