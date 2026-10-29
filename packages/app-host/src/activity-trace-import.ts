import { z } from "zod";
import {
	jsonResponseDocumentSchema,
	jsonResponseValueSchema,
} from "./json-values.ts";

/** Native forwards Core's snake_case envelope; Desktop returns its normalized
 * camelCase DTO. Preserve both producers' field names and original JSON. */
const promptSuiteWireFieldsSchema = z.object({
	agent_id: z.string(),
	config: jsonResponseValueSchema,
	created_at: z.number(),
	id: z.string(),
	name: z.string(),
	updated_at: z.number(),
});
const promptVersionWireFieldsSchema = z.object({
	config: jsonResponseValueSchema.nullish(),
	created_at: z.number(),
	id: z.string(),
	label: z.string().nullish(),
	suite_id: z.string(),
});
const promptSuiteFieldsSchema = z.object({
	agentId: z.string(),
	config: jsonResponseValueSchema,
	createdAt: z.number(),
	id: z.string(),
	name: z.string(),
	updatedAt: z.number(),
});
const promptVersionFieldsSchema = z.object({
	config: jsonResponseValueSchema,
	createdAt: z.number(),
	id: z.string(),
	label: z.string().nullable(),
	suiteId: z.string(),
});
const traceImportFieldsSchema = z.union([
	z.object({
		added: z.boolean(),
		case: jsonResponseValueSchema,
		source_run_id: z.string(),
		suite: promptSuiteWireFieldsSchema,
		version: promptVersionWireFieldsSchema.nullish(),
	}),
	z.object({
		added: z.boolean(),
		case: jsonResponseValueSchema,
		sourceRunId: z.string(),
		suite: promptSuiteFieldsSchema,
		version: promptVersionFieldsSchema.nullable(),
	}),
]);
export const activityTraceImportRecordSchema = z.custom<
	z.output<typeof traceImportFieldsSchema>
>(
	(value) =>
		jsonResponseDocumentSchema.safeParse(value).success &&
		traceImportFieldsSchema.safeParse(value).success
);
export type ActivityTraceImportRecord = z.output<
	typeof activityTraceImportRecordSchema
>;
