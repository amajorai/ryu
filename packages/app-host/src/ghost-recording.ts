import type {
	LearnedEvent,
	Recipe,
	RecipeLocator,
	RecipeParam,
	RecipeStep,
	RecipeSummary,
	RecordingState,
	RecordingStopResult,
} from "@ryuhq/core-client/recipes";
import { z } from "zod";

/** Core owns additive metadata; validation must retain the original transport value. */
function preserveRecordingResponse<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>((value) => schema.safeParse(value).success);
}
function recordingDictionary<S extends z.ZodType>(entry: S) {
	const dictionary = z.record(z.string(), entry);
	return z.custom<z.output<typeof dictionary>>((value) => {
		if (!dictionary.safeParse(value).success) {
			return false;
		}
		const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
		return !prototypeEntry || entry.safeParse(prototypeEntry.value).success;
	});
}
const recipeParameterSchema = z.object({
	description: z.string(),
	required: z.boolean().nullable().optional(),
	type: z.string(),
}) satisfies z.ZodType<RecipeParam>;
const recipeLocatorSchema = z.object({
	app: z.string().nullable().optional(),
	dom_class: z.string().nullable().optional(),
	dom_id: z.string().nullable().optional(),
	identifier: z.string().nullable().optional(),
	query: z.string().nullable().optional(),
	role: z.string().nullable().optional(),
}) satisfies z.ZodType<RecipeLocator>;
const recipeStepSchema = z.object({
	action: z.string(),
	id: z.number(),
	note: z.string().nullable().optional(),
	on_failure: z.string().nullable().optional(),
	params: recordingDictionary(z.string()).nullable().optional(),
	target: recipeLocatorSchema.nullable().optional(),
}) satisfies z.ZodType<RecipeStep>;
const recipeSchema = z.object({
	app: z.string().nullable().optional(),
	description: z.string(),
	name: z.string(),
	on_failure: z.string().nullable().optional(),
	params: recordingDictionary(recipeParameterSchema).nullable().optional(),
	preconditions: z
		.object({
			app_running: z.string().nullable().optional(),
			url_contains: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
	schema_version: z.number(),
	steps: z.array(recipeStepSchema),
}) satisfies z.ZodType<Recipe>;
const learnedEventSchema = z.object({
	app_name: z.string().nullable().optional(),
	element_id: z.string().nullable().optional(),
	element_name: z.string().nullable().optional(),
	element_role: z.string().nullable().optional(),
	event_type: z.string(),
	key: z.string().nullable().optional(),
	ts_ms: z.number(),
	x: z.number().nullable().optional(),
	y: z.number().nullable().optional(),
}) satisfies z.ZodType<LearnedEvent>;
export const ghostRecipeSummarySchema = preserveRecordingResponse(
	z.object({
		app: z.string().nullable(),
		description: z.string(),
		name: z.string(),
		params: z.array(z.string()),
		step_count: z.number(),
	}) satisfies z.ZodType<RecipeSummary>
);
export const ghostRecipeSummariesSchema = preserveRecordingResponse(
	z.array(ghostRecipeSummarySchema)
);
export const ghostRecordingStateSchema = preserveRecordingResponse(
	z.object({
		recording: z.boolean(),
		started_at: z.string().optional(),
		status: z.json().optional(),
		task: z.string().optional(),
	}) satisfies z.ZodType<RecordingState>
);
// The sidecar preserves older ghost payloads without event_count/events; its
// draft still supplies the editable recording and the shell can use the legacy fallback.
export const ghostRecordingStopSchema = preserveRecordingResponse(
	z.object({
		draft: recipeSchema.optional(),
		event_count: z.number().optional(),
		events: z.array(learnedEventSchema).optional(),
		recording: z.literal(false),
		started_at: z.string(),
		suggestion: z.string().optional(),
		task: z.string(),
	}) satisfies z.ZodType<
		Pick<RecordingStopResult, "recording" | "started_at" | "task"> &
			Partial<RecordingStopResult>
	>
);
export type GhostRecordingState = z.output<typeof ghostRecordingStateSchema>;
export type GhostRecordingStop = z.output<typeof ghostRecordingStopSchema>;
