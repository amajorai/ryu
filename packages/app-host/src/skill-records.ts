import { z } from "zod";
import { jsonResponseValueSchema } from "./json-values.ts";

/** The trusted skill client normalizes Core's records to these camelCase DTOs.
 * Retain the original objects and additive JSON metadata after validation. */
function preserveSkillResponse<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>((value) => {
		if (
			!fields.catchall(jsonResponseValueSchema.optional()).safeParse(value)
				.success
		) {
			return false;
		}
		const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
		return (
			!prototypeEntry ||
			jsonResponseValueSchema.optional().safeParse(prototypeEntry.value).success
		);
	});
}

export const skillSourceRecordSchema = preserveSkillResponse(
	z.object({
		allowedTools: z.array(z.string()),
		alwaysOn: z.boolean(),
		body: z.string(),
		description: z.string().nullable(),
		id: z.string(),
		name: z.string(),
		source: z.string(),
	})
);
export type SkillSourceRecord = z.output<typeof skillSourceRecordSchema>;

export const skillWriteRecordSchema = preserveSkillResponse(
	z.object({ id: z.string(), source: z.string() })
);
export type SkillWriteRecord = z.output<typeof skillWriteRecordSchema>;

export const skillVersionRecordSchema = preserveSkillResponse(
	z.object({
		createdAt: z.number(),
		id: z.string(),
		label: z.string().nullable(),
		name: z.string(),
	})
);
export type SkillVersionRecord = z.output<typeof skillVersionRecordSchema>;

const skillVersionRowsSchema = z.array(skillVersionRecordSchema);
export const skillVersionRecordsSchema = z.custom<
	z.output<typeof skillVersionRowsSchema>
>((value) => skillVersionRowsSchema.safeParse(value).success);
