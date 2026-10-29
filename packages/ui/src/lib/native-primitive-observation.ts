import nativeObjectLike from "lodash/isObjectLike.js";
import { z } from "zod";

const nativeFunctionSchema = z.function();
const nativeTextSchema = z.string();
const nativeBooleanSchema = z.boolean();
const nativeBigIntSchema = z.bigint();
// Separate raw scalar runs preserve all native number brands, including NaN
// and infinities, without union issue finalization or configured error maps.
const nativeNumberSchemas = [
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
] as const;
/** The installed synchronous scalar parser observes only its native primitive
 * brand. Read the raw payload without formatting a ZodError: reporting rejected
 * opaque receivers would introduce getPrototypeOf/coercion Proxy traps. These
 * scalar observers preserve native primitive checks, not object DTOs. */
export function isNativeFunction(
	value: Parameters<typeof nativeFunctionSchema.parse>[0]
): value is typeof globalThis.Function.prototype {
	const payload = { value, issues: [] };
	nativeFunctionSchema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}
export function isNativeText(
	value: Parameters<typeof nativeTextSchema.parse>[0]
): value is string {
	const payload = { value, issues: [] };
	nativeTextSchema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}

export function isNativeBoolean(
	value: Parameters<typeof nativeBooleanSchema.parse>[0]
): value is boolean {
	const payload = { value, issues: [] };
	nativeBooleanSchema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}
export function isNativeBigInt(
	value: Parameters<typeof nativeBigIntSchema.parse>[0]
): value is bigint {
	const payload = { value, issues: [] };
	nativeBigIntSchema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}

export function isNativeNumber(
	value: Parameters<(typeof nativeNumberSchemas)[number]["parse"]>[0]
): value is number {
	for (const schema of nativeNumberSchemas) {
		const payload = { value, issues: [] };
		schema._zod.run(payload, { async: false });
		if (payload.issues.length === 0) {
			return true;
		}
	}
	return false;
}

export { default as isNativeObject } from "lodash/isObject.js";
// Preserve the complete installed native optional-input/boolean-return ABI.
// This is an observation only; no universal structural object predicate is asserted.
export { default as isNativeObjectLike } from "lodash/isObjectLike.js";

/** Observe only the installed native non-null object brand. Arrays, boxed
 * values and opaque object proxies remain admitted; no field shape is inferred. */
export function isNativeObjectReceiver(
	value: Parameters<typeof nativeObjectLike>[0]
): value is object {
	return nativeObjectLike(value);
}
