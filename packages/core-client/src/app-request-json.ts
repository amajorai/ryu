import { z } from "zod";

const serializableScalarSchema = z.union([
	z.string(),
	z.boolean(),
	z.null(),
	z.undefined(),
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
/** Values supplied to native JSON.stringify: undefined properties are omitted,
 * undefined array slots/non-finite numbers become null. Core owns JSON business
 * validation; this transport retains the original future fields and references. */
export type AppRequestValue =
	| z.output<typeof serializableScalarSchema>
	| AppRequestValue[]
	| { [key: string]: AppRequestValue };
const atomicJsonSchema = z.union([
	z.string(),
	z.boolean(),
	z.null(),
	z.number(),
]);
const nativeJsonScalarSchema = z.union([
	atomicJsonSchema,
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
interface TransportValidationFrame {
	leave?: object;
	value: Parameters<typeof serializableScalarSchema.safeParse>[0];
}
/** Validate the entire native JSON tree without a JavaScript stack-depth limit. */
function isTransportValue(
	value: Parameters<typeof serializableScalarSchema.safeParse>[0],
	scalar: z.ZodType
): boolean {
	try {
		const pending: TransportValidationFrame[] = [{ value }];
		const active = new WeakSet<object>();
		while (pending.length) {
			const frame = pending.pop();
			if (!frame) {
				return false;
			}
			if (frame.leave) {
				active.delete(frame.leave);
				continue;
			}
			// Containers need traversal, so avoid constructing scalar-union errors
			// for every nested array/object in a deeply parsed native response.
			const container =
				Array.isArray(frame.value) || z.core.util.isPlainObject(frame.value)
					? frame.value
					: undefined;
			if (!container) {
				if (scalar.safeParse(frame.value).success) {
					continue;
				}
				return false;
			}
			if (active.has(container)) {
				return false;
			}
			active.add(container);
			pending.push({ value: null, leave: container });
			const prototypeEntry = Object.getOwnPropertyDescriptor(
				container,
				"__proto__"
			);
			if (
				prototypeEntry &&
				(Array.isArray(container) || !prototypeEntry.enumerable)
			) {
				pending.push({ value: prototypeEntry.value });
			}
			if (Array.isArray(container)) {
				for (let index = container.length - 1; index >= 0; index--) {
					pending.push({ value: container[index] });
				}
			} else {
				for (const key of Object.getOwnPropertySymbols(container)) {
					if (Object.getOwnPropertyDescriptor(container, key)?.enumerable) {
						return false;
					}
				}
				const entries = Object.entries(container);
				for (let index = entries.length - 1; index >= 0; index--) {
					const entry = entries[index];
					if (entry) {
						pending.push({ value: entry[1] });
					}
				}
			}
		}
		return true;
	} catch {
		return false;
	}
}
export const appRequestValueSchema = z.custom<AppRequestValue>((value) =>
	isTransportValue(value, serializableScalarSchema)
);
/** Actual JSON HTTP replies, including the existing no-content undefined reply. */
export const appResponseValueSchema = z.custom<
	z.core.util.JSONType | undefined
>(
	(value) =>
		value === undefined || isTransportValue(value, nativeJsonScalarSchema)
);
export type AppResponseValue = z.output<typeof appResponseValueSchema>;
/** A required serde_json::Value, retaining every native JSON key and reference. */
export const appJsonValueSchema = z.custom<z.core.util.JSONType>((value) =>
	isTransportValue(value, atomicJsonSchema)
);
export type AppJsonValue = z.output<typeof appJsonValueSchema>;
