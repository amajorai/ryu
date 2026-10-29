import { z } from "zod";
export const nativeNumberSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const objectAdmission = z.custom<object>(
	(value) => z.looseObject({}).safeParse(value).success
);
const atomicJsonSchema = z.union([
	z.null(),
	z.boolean(),
	z.string(),
	nativeNumberSchema,
]);
interface JsonValidationFrame {
	leave?: object;
	value: Parameters<typeof atomicJsonSchema.safeParse>[0];
}
function isNativeJson(
	value: Parameters<typeof atomicJsonSchema.safeParse>[0]
): boolean {
	const pending: JsonValidationFrame[] = [{ value }];
	const active = new WeakSet<object>();
	while (pending.length > 0) {
		const frame = pending.pop();
		if (!frame) {
			return false;
		}
		if (frame.leave) {
			active.delete(frame.leave);
			continue;
		}
		if (atomicJsonSchema.safeParse(frame.value).success) {
			continue;
		}
		const admission = objectAdmission.safeParse(frame.value);
		if (!(Array.isArray(frame.value) || admission.success)) {
			return false;
		}
		const container = Array.isArray(frame.value) ? frame.value : admission.data;
		if (!container || active.has(container)) {
			return false;
		}
		active.add(container);
		pending.push({ value: null, leave: container });
		for (const child of Array.isArray(container)
			? container
			: Object.values(container)) {
			pending.push({ value: child });
		}
	}
	return true;
}
export const nativeJsonSchema = z.custom<z.core.util.JSONType>(isNativeJson);
