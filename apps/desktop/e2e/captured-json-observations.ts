import { expect } from "@playwright/test";
import { isNativeObjectLike } from "@ryu/ui/lib/native-primitive-observation.ts";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

const rawJsonRecordSchema = z.record(z.string(), appResponseValueSchema);
const capturedJsonObjectSchema = z.custom<z.input<typeof rawJsonRecordSchema>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		isNativeObjectLike(value) &&
		!Array.isArray(value)
);

/** Observe a captured native JSON field, retaining the complete raw tree.
 * These checks describe the transport object, not a project or another DTO. */
export function capturedJsonField(
	value: Parameters<typeof appResponseValueSchema.parse>[0],
	key: string
) {
	const admission = capturedJsonObjectSchema.safeParse(value);
	expect(admission.success, "Expected a captured JSON object").toBe(true);
	if (!admission.success) {
		throw new Error("Expected a captured JSON object");
	}
	const object = admission.data;
	expect(Object.hasOwn(object, key), `Expected captured own field ${key}`).toBe(
		true
	);
	return object[key];
}

/** Require the native collection at the original array operation's use site. */
export function capturedJsonArray(
	value: Parameters<typeof appResponseValueSchema.parse>[0]
) {
	const decoded = appResponseValueSchema.parse(value);
	expect(Array.isArray(decoded), "Expected a captured JSON array").toBe(true);
	if (!Array.isArray(decoded)) {
		throw new Error("Expected a captured JSON array");
	}
	return decoded;
}
