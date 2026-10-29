import { z } from "zod";
import {
	type PromptfooValue,
	parsePromptfooDocument,
	parsePromptfooValue,
} from "../promptfoo.ts";
import {
	pluginDocumentSchema,
	pluginValueSchema,
} from "./plugin-wire-values.ts";

/** Complete Core wire records retain saved JSON, including unsupported future configuration. */
function promptWireRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const promptSuiteWireSchema = promptWireRecord(
	z.object({
		agent_id: z.string(),
		config: pluginValueSchema,
		created_at: z.number(),
		id: z.string(),
		name: z.string(),
		updated_at: z.number(),
	})
);
export const promptSuiteVersionWireSchema = promptWireRecord(
	z.object({
		config: pluginValueSchema.nullish(),
		created_at: z.number(),
		id: z.string(),
		label: z.string().nullish(),
		suite_id: z.string(),
	})
);
const promptRunMetaFields = z.object({
	created_at: z.number(),
	id: z.string(),
	name: z.string(),
	suite_id: z.string(),
});
export const promptRunMetaWireSchema = promptWireRecord(promptRunMetaFields);
export const promptRunWireSchema = promptWireRecord(
	promptRunMetaFields.extend({
		request: pluginValueSchema,
		result: pluginValueSchema,
	})
);
export const promptReviewWireSchema = promptWireRecord(
	z.object({
		comment: z.string().nullish(),
		highlighted: z.boolean().nullish(),
		pass: z.boolean().nullish(),
		result_key: z.string(),
		run_id: z.string(),
		score: z.number().nullish(),
		updated_at: z.number(),
	})
);
export const promptSuiteEnvelopeSchema = z.object({
	suite: promptSuiteWireSchema,
});
export const promptSuiteSaveEnvelopeSchema = z.object({
	suite: promptSuiteWireSchema,
	version: promptSuiteVersionWireSchema.nullish(),
});
export const promptSuiteListEnvelopeSchema = z.object({
	suites: z.array(promptSuiteWireSchema).nullish(),
});
export const promptSuiteVersionEnvelopeSchema = z.object({
	version: promptSuiteVersionWireSchema,
});
export const promptSuiteVersionsEnvelopeSchema = z.object({
	versions: z.array(promptSuiteVersionWireSchema).nullish(),
});
export const promptRunsEnvelopeSchema = z.object({
	runs: z.array(promptRunMetaWireSchema).nullish(),
});
export const promptRunMetaEnvelopeSchema = z.object({
	run: promptRunMetaWireSchema,
});
export const promptRunEnvelopeSchema = z.object({ run: promptRunWireSchema });
export const promptReviewsEnvelopeSchema = z.object({
	reviews: z.array(promptReviewWireSchema).nullish(),
});
export const promptReviewEnvelopeSchema = z.object({
	review: promptReviewWireSchema,
});
export const promptTraceEnvelopeSchema = z.object({
	added: z.boolean(),
	case: pluginValueSchema,
	source_run_id: z.string(),
	suite: promptSuiteWireSchema,
	version: promptSuiteVersionWireSchema.nullish(),
});

/** Drafts use Promptfoo's actual JSON/YAML serialization owner: undefined is omitted
 * and nonfinite YAML scalars serialize to null before reaching Core. */
const promptDraftValueSchema = z.custom<PromptfooValue>((value) => {
	try {
		parsePromptfooValue(value);
		return true;
	} catch {
		return false;
	}
});
export const promptSuiteCreateInputSchema = z.object({
	agentId: z.string(),
	config: promptDraftValueSchema,
	label: z.string().nullish(),
	name: z.string(),
});
export const promptSuiteUpdateInputSchema = z.object({
	config: promptDraftValueSchema,
	label: z.string().nullish(),
	name: z.string(),
});
const promptRunSaveInputFields = z
	.object({
		name: z.string().optional(),
		request: promptDraftValueSchema,
		result: promptDraftValueSchema,
	})
	.catchall(promptDraftValueSchema);
export const promptRunSaveInputSchema = z.custom<
	z.output<typeof promptRunSaveInputFields>
>((value) => {
	try {
		parsePromptfooDocument(value);
		return promptRunSaveInputFields.safeParse(value).success;
	} catch {
		return false;
	}
});
export const promptReviewSaveInputSchema = z.object({
	comment: z.string().nullish(),
	highlighted: z.boolean().nullish(),
	pass: z.boolean().nullish(),
	resultKey: z.string(),
	score: z.number().nullish(),
});
