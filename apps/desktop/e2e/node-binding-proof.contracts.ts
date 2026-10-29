import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

const bindingRequestFields = z.object({
	authorization: z.string().nullable(),
	body: appResponseValueSchema,
	method: z.string(),
	path: z.string(),
	query: z.string(),
});
/** Admit the full serialized observation and preserve all native JSON fields. */
export const bindingRequestsSchema = z.custom<
	z.output<typeof bindingRequestFields>[]
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		Array.isArray(value) &&
		value.every(
			(item) =>
				bindingRequestFields.safeParse(item).success &&
				Object.keys(bindingRequestFields.shape).every((key) =>
					Object.hasOwn(item, key)
				)
		)
);
export type BindingRequest = z.output<typeof bindingRequestsSchema>[number];
export interface BindingProof {
	requests: () => BindingRequest[];
}
declare global {
	interface Window {
		__nodeBindingProof?: BindingProof;
	}
}

const bodyFields = z.record(z.string(), appResponseValueSchema);
/** The complete native enrollment body, observed at the existing key assertion. */
export const bindingBodyObservationSchema = z.custom<
	z.output<typeof bodyFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		bodyFields.safeParse(value).success
);

export const bindingInputStringSchema = z.string();
const finiteJson = z.json();
const nativeFiniteJson = z.custom<z.output<typeof finiteJson>>(
	(value) => finiteJson.safeParse(value).success
);
/** Preserve the fixture's finite JSON policy and two native BodyInit reads. */
// SAFETY: ECMAScript JSON.parse applies native ToString to its argument; the SDK's
// string-only declaration omits that coercion. This fixture deliberately passes
// the second native RequestInit.body read, preserving getter order and native
// coercion/errors, then validates the complete parsed result below.
const nativeBodyParse = JSON.parse as (
	text: RequestInit["body"]
) => ReturnType<typeof JSON.parse>;

export function bindingRequestBody(
	init?: RequestInit
): z.output<typeof nativeFiniteJson> {
	const body = bindingInputStringSchema.safeParse(init?.body);
	if (!body.success) {
		return null;
	}
	const parsed = nativeBodyParse.apply(JSON, [init?.body]);
	// Preserve the original finite decoder's native Zod error payload, while
	// retaining the parsed object's own fields rather than its cloned output.
	finiteJson.parse(parsed);
	return nativeFiniteJson.parse(parsed);
}
