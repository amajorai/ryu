/** Full values produced by native JSON.parse without a reviver, including numeric overflow. */
export type NativeJsonValue =
	| null
	| boolean
	| number
	| string
	| NativeJsonValue[]
	| { [key: string]: NativeJsonValue };
/** An indexed JSON member may be absent; absence is distinct from native JSON null. */
export type NativeJsonSlot = NativeJsonValue | undefined;
export interface NativeJsonObject {
	[key: string]: NativeJsonValue;
}
const nativeStringValue = String.prototype.valueOf;
const nativeFunctionText = Function.prototype.toString;
/** Decode a primitive text member without coercion or invoking user hooks. */
export function nativeJsonText(value: NativeJsonSlot): string | null {
	try {
		const text = nativeStringValue.call(value);
		return value === text ? text : null;
	} catch {
		// The native string brand operation rejects non-string receivers.
		return null;
	}
}
export function nativeJsonObject(
	value: NativeJsonSlot
): value is NativeJsonObject {
	if (value === null || value === undefined || Array.isArray(value)) {
		return false;
	}
	const carrier = new Object(value);
	if (carrier !== value) {
		return false;
	}
	try {
		nativeFunctionText.call(value);
		return false;
	} catch {
		// Native functions are excluded; JSON object members keep their original receiver.
		return true;
	}
}
export function parseNativeJson(text: string): NativeJsonValue {
	// SAFETY: native JSON.parse without a reviver validates the complete JSON grammar
	// and produces exactly this recursive domain; overflow may produce +/-Infinity.
	return JSON.parse(text) as NativeJsonValue;
}

const nativeNumberValue = Number.prototype.valueOf;
export function nativeJsonNumber(value: NativeJsonSlot): number | null {
	try {
		const number = nativeNumberValue.call(value);
		return Object.is(number, value) ? number : null;
	} catch {
		// The native numeric brand operation rejects non-number receivers.
		return null;
	}
}

/** Native primitive-brand decoder for arbitrary SDK fields; no coercion or user hooks. */
export function hasNativeTextBrand<T>(value: T): value is T & string {
	try {
		return nativeStringValue.call(value) === value;
	} catch {
		return false;
	}
}
/** Genuine native object receiver, including arrays and Error subclasses, excluding callables. */
export function isNativeObjectReceiver<T>(value: T): value is T & object {
	if (value === null || value === undefined) {
		return false;
	}
	const carrier = new Object(value);
	if (carrier !== value) {
		return false;
	}
	try {
		nativeFunctionText.call(value);
		return false;
	} catch {
		return true;
	}
}
