import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/recipes.ts
//
// Typed client for the Core ghost-recipes record verbs (`/api/recipes/record/*`)
// that give Ryu's workflow system ghost-os parity. A recipe is a parameterized,
// recorded native-desktop automation — a frontier model records it once, a small
// model (or a workflow) replays it forever. All logic is in Core; this is a thin
// transport layer over the shared {@link request} plumbing (base URL + bearer
// come from the node). Show / run / delete live in `@ryuhq/core-client/recipes`.

import {
	type LearnedEvent,
	type Recipe,
	type RecipeLocator,
	type RecipeParam,
	type RecipeStep,
	type RecordingState,
	type RecordingStopResult,
	recordingStateResponseSchema,
} from "@ryuhq/core-client/recipes.ts";

// The offline draft fallback is pure, so it is shared rather than copied.
export {
	draftRecipeFromEvents,
	type RecordingState,
	type RecordingStopResult,
} from "@ryuhq/core-client/recipes.ts";

import { type ApiTarget, request } from "./client.ts";

const recipeParamResponseCodec: z.ZodType<RecipeParam> = z
	.object({
		description: z.string(),
		required: z.boolean().optional(),
		type: z.string(),
	})
	.passthrough();
const recipeLocatorResponseCodec: z.ZodType<RecipeLocator> = z
	.object({
		app: z.union([z.string(), z.null()]).optional(),
		dom_class: z.union([z.string(), z.null()]).optional(),
		dom_id: z.union([z.string(), z.null()]).optional(),
		identifier: z.union([z.string(), z.null()]).optional(),
		query: z.union([z.string(), z.null()]).optional(),
		role: z.union([z.string(), z.null()]).optional(),
	})
	.passthrough();
const recipeStepResponseCodec: z.ZodType<RecipeStep> = z
	.object({
		action: z.string(),
		id: z.number(),
		note: z.union([z.string(), z.null()]).optional(),
		on_failure: z.union([z.string(), z.null()]).optional(),
		params: z.union([z.record(z.string(), z.string()), z.null()]).optional(),
		target: z.union([recipeLocatorResponseCodec, z.null()]).optional(),
	})
	.passthrough();
const recipeResponseCodec: z.ZodType<Recipe> = z
	.object({
		app: z.union([z.string(), z.null()]).optional(),
		description: z.string(),
		name: z.string(),
		on_failure: z.union([z.string(), z.null()]).optional(),
		params: z
			.union([z.record(z.string(), recipeParamResponseCodec), z.null()])
			.optional(),
		preconditions: z
			.union([
				z
					.object({
						app_running: z.union([z.string(), z.null()]).optional(),
						url_contains: z.union([z.string(), z.null()]).optional(),
					})
					.passthrough(),
				z.null(),
			])
			.optional(),
		schema_version: z.number(),
		steps: z.array(recipeStepResponseCodec),
	})
	.passthrough();
const learnedEventResponseCodec: z.ZodType<LearnedEvent> = z
	.object({
		app_name: z.union([z.string(), z.null()]).optional(),
		element_id: z.union([z.string(), z.null()]).optional(),
		element_name: z.union([z.string(), z.null()]).optional(),
		element_role: z.union([z.string(), z.null()]).optional(),
		event_type: z.string(),
		key: z.union([z.string(), z.null()]).optional(),
		ts_ms: z.number(),
		x: z.union([z.number(), z.null()]).optional(),
		y: z.union([z.number(), z.null()]).optional(),
	})
	.passthrough();
const recordingStopResultResponseCodec: z.ZodType<RecordingStopResult> = z
	.object({
		draft: recipeResponseCodec.optional(),
		event_count: z.number(),
		events: z.array(learnedEventResponseCodec),
		recording: z.literal(false),
		started_at: z.string(),
		suggestion: z.string().optional(),
		task: z.string(),
	})
	.passthrough();

// The recipe list is no longer read here: Companions call the Recipes app's list
// route through `app.request({ app: "@ryu/recipes" })`, and the legacy
// `ghost.recipes` host verb is served by `@ryu/app-host/recipes-compat`.

export async function startRecording(
	target: ApiTarget,
	task: string
): Promise<RecordingState> {
	return recordingStateResponseSchema.parse(
		await request(
			target,
			"/api/recipes/record/start",
			{
				method: "POST",
				body: { task },
			},
			gatewayJsonValueSchema
		)
	);
}

export async function getRecordingStatus(
	target: ApiTarget
): Promise<RecordingState> {
	return recordingStateResponseSchema.parse(
		await request(
			target,
			"/api/recipes/record/status",
			{},
			gatewayJsonValueSchema
		)
	);
}

export async function stopRecording(
	target: ApiTarget
): Promise<RecordingStopResult> {
	return await request<RecordingStopResult>(
		target,
		"/api/recipes/record/stop",
		{ method: "POST" },
		recordingStopResultResponseCodec
	);
}
