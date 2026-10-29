import type { AppRequestValue } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

const objectAdmission = z.custom<object>(
	(value) => z.looseObject({}).safeParse(value).success
);
const atomicJson = z.union([
	z.null(),
	z.boolean(),
	z.string(),
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
interface JsonValidationFrame {
	leave?: object;
	value: Parameters<typeof atomicJson.safeParse>[0];
}
/** Traverse native JSON without imposing a JavaScript call-stack depth limit. */
function isJson(
	value: Parameters<typeof atomicJson.safeParse>[0],
	scalars: z.ZodType = atomicJson
): boolean {
	const pending: JsonValidationFrame[] = [{ value }];
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
		if (scalars.safeParse(frame.value).success) {
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
		for (const entry of Array.isArray(container)
			? container
			: Object.values(container)) {
			pending.push({ value: entry });
		}
	}
	return true;
}
const requestScalars = z.union([atomicJson, z.undefined(), z.nan()]);
/** Persisted tool values use Core's request JSON domain; retain deep future fields and native references. */
export const turnEndValueSchema = z.custom<AppRequestValue>((value) =>
	isJson(value, requestScalars)
);
export const turnEndRecordSchema = z.custom<Record<string, AppRequestValue>>(
	(value) =>
		objectAdmission.safeParse(value).success && isJson(value, requestScalars)
);
export const turnEndPartsSchema = z.custom<AppRequestValue[]>(
	(value) => Array.isArray(value) && isJson(value, requestScalars)
);
export function isTurnEndText(value: AppRequestValue): value is string {
	return z.string().safeParse(value).success;
}
export function isTurnEndRecord(
	value: AppRequestValue
): value is Record<string, AppRequestValue> {
	return objectAdmission.safeParse(value).success;
}
