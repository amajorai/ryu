/** Complete successful result domain of the authored native property operation,
 * including callable objects. This describes member access, not a classifier or
 * a parsed part/metadata record. Native accessor/key-coercion exceptions propagate. */
export type NativePropertyValue =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| object;

/** Both operands are genuinely polymorphic: the native JS operation owns boxing,
 * key conversion, and nullish receiver admission without a structural promise. */
export function observeNativeOptionalProperty<Receiver, Key>(
	receiver: Receiver,
	key: Key
): NativePropertyValue;
