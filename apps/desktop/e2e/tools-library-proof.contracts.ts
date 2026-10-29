import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

/** The native HTTP carrier preserves complete future JSON fields and references. */
export const toolsProofJsonSchema = appResponseValueSchema;
export type ToolsProofJson = z.output<typeof toolsProofJsonSchema>;
const recordFields = z.record(z.string(), toolsProofJsonSchema.nonoptional());
export const toolsProofRecordSchema = z.custom<z.output<typeof recordFields>>(
	(value) =>
		toolsProofJsonSchema.safeParse(value).success &&
		recordFields.safeParse(value).success
);
function preserveToolsRequest<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			toolsProofRecordSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const secretFields = z.record(z.string(), z.string());
const writeFields = {
	args: z.array(z.string()).nullable().optional(),
	command: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	enabled: z.boolean().nullable().optional(),
	env: secretFields.nullable().optional(),
	headers: secretFields.nullable().optional(),
	name: z.string().optional(),
	type: z.string().nullable().optional(),
	url: z.string().nullable().optional(),
};
// Complete create/update body emitted by Desktop api/mcp.ts. Optional omissions,
// legacy null defaults and future transport strings remain native fixture inputs.
export const toolsServerCreateSchema = preserveToolsRequest(
	z.looseObject({ ...writeFields, name: z.string() })
);
export const toolsServerUpdateSchema = preserveToolsRequest(
	z.looseObject(writeFields)
);
export const toolsCallSchema = preserveToolsRequest(
	z.looseObject({
		tool: z.string(),
		agent_id: z.string(),
		arguments: toolsProofJsonSchema.optional(),
	})
);
const queryObservationSchema = z.object({
	query: toolsProofJsonSchema.optional(),
});
/** Observe the fixture's query without claiming all tool arguments are objects.
 * Native JSON primitives box to an absent property; null/omission throw exactly
 * as the original property read did, after the fixture's first-call refusal. */
export function toolsQuery(
	value: ToolsProofJson | undefined
): ToolsProofJson | undefined {
	if (value === null || value === undefined) {
		throw new TypeError(`Cannot read properties of ${value} (reading 'query')`);
	}
	const observation = queryObservationSchema.safeParse(value);
	return observation.success ? observation.data.query : undefined;
}
