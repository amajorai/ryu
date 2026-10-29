import type { DynamicToolUIPart } from "ai";

interface NativeCreatedAtLookup {
	readonly createdAt?: DynamicToolUIPart["input"] | DynamicToolUIPart["output"];
}
export function nativeCreatedAtLookup(
	value: DynamicToolUIPart["input"] | DynamicToolUIPart["output"]
): NativeCreatedAtLookup | null | undefined {
	// SAFETY: this erased native optional-property ABI exposes only an opaque
	// slot on the actual SDK carrier. It asserts neither an object/Date brand nor
	// a decoded message; no boxing or inspection changes inherited/Proxy reads.
	return value as NativeCreatedAtLookup | null | undefined;
}
export function nativeMessageDate(
	value: DynamicToolUIPart["input"] | DynamicToolUIPart["output"]
): Date {
	// SAFETY: the ECMAScript Date constructor's actual single-argument operation
	// accepts every JavaScript value and performs native Date/ToPrimitive logic.
	// This view widens only that native argument ABI, not its successful result.
	// Date is resolved at each invocation; coercion callbacks, receivers, native
	// errors and patched constructor/newTarget semantics remain unchanged.
	const NativeDate = Date as new (
		value: DynamicToolUIPart["input"] | DynamicToolUIPart["output"]
	) => Date;
	return new NativeDate(value);
}
