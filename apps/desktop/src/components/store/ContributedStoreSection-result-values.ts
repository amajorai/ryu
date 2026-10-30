import { type ViewSourceRow, viewSourceRowSchema } from "@ryu/app-host/views";
import { z } from "zod";

/** Flatten an install response into `{{result.<key>}}` template values. Only scalar
 *  leaves are exposed — a nested object in a route template would stringify to JSON
 *  and produce a broken path. */
const resultScalarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);
export function resultValues(
	payload: Parameters<typeof viewSourceRowSchema.safeParse>[0]
): ViewSourceRow {
	const parsed = viewSourceRowSchema.safeParse(payload);
	if (!parsed.success) {
		return {};
	}
	const out: ViewSourceRow = {};
	for (const [key, value] of Object.entries(parsed.data)) {
		const scalar = resultScalarSchema.safeParse(value);
		if (scalar.success) {
			out[`result.${key}`] = scalar.data;
		}
	}
	return out;
}
