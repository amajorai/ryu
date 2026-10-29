import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

const requestStringSchema = z.string();
const recordFields = z.record(z.string(), appResponseValueSchema);
/** Full native JSON carrier at the fixture's original object/key-presence gate.
 * Governance owns all four Worktree values and their tolerant normalization. */
export const worktreeUpdateObservationSchema = z.custom<
	z.output<typeof recordFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		recordFields.safeParse(value).success
);
export const worktreePreferenceWriteSchema = z.object({ value: z.string() });
/** Match the installed RequestInit BodyInit contract and existing empty default. */
// SAFETY: ECMAScript JSON.parse applies native ToString to its argument; the SDK's
// string-only declaration omits that coercion. This fixture deliberately passes
// the second native RequestInit.body read, preserving getter order and native
// coercion/errors, then validates the complete parsed result below.
const nativeBodyParse = JSON.parse as (
	text: RequestInit["body"]
) => ReturnType<typeof JSON.parse>;

export function worktreeRequestBody(
	init?: RequestInit
): z.output<typeof appResponseValueSchema> {
	const body = requestStringSchema.safeParse(init?.body);
	// The old native JSON.parse coerces its argument and reads a string body a
	// second time. Retain that receiver/read order for actual RequestInit getters;
	// the complete native JSON result is admitted immediately after parsing.
	return appResponseValueSchema.parse(
		nativeBodyParse.apply(JSON, [body.success ? init?.body : "{}"])
	);
}
