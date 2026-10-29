// apps/desktop/src/lib/api/recipes.ts
//
// Typed client for the Core ghost-recipes surface (`/api/recipes/*`): the
// record / list / show / run / delete flow that gives Ryu's workflow system
// ghost-os parity. A recipe is a parameterized, recorded native-desktop
// automation — a frontier model records it once, a small model (or a workflow)
// replays it forever. All logic is in Core; this is a thin transport layer over
// the shared {@link request} plumbing (base URL + bearer come from the node).

import { z } from "zod";
import {
	type AppJsonValue,
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

function recipeResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
function recipeMap<S extends z.ZodType>(entry: S) {
	const fields = z.record(z.string(), entry);
	return z.custom<z.output<typeof fields>>(
		(value) =>
			fields.safeParse(value).success &&
			Object.values(new Object(value)).every(
				(item) => entry.safeParse(item).success
			)
	);
}
const recipeLocatorSchema = recipeResponse(
	z.object({
		app: z.string().nullish(),
		dom_class: z.string().nullish(),
		dom_id: z.string().nullish(),
		identifier: z.string().nullish(),
		query: z.string().nullish(),
		role: z.string().nullish(),
	})
);
const recipeWaitSchema = recipeResponse(
	z.object({
		condition: z.string(),
		target: recipeLocatorSchema.nullish(),
		value: z.string().nullish(),
		timeout: z.number().nullish(),
	})
);
const recipeParamSchema = recipeResponse(
	z.object({
		description: z.string(),
		required: z.boolean().nullish(),
		type: z.string(),
	})
);
const recipeStepSchema = recipeResponse(
	z.object({
		action: z.string(),
		id: z.number(),
		note: z.string().nullish(),
		on_failure: z.string().nullish(),
		params: recipeMap(z.string()).nullish(),
		target: recipeLocatorSchema.nullish(),
		wait_after: recipeWaitSchema.nullish(),
	})
);
export const recipeResponseSchema = recipeResponse(
	z.object({
		schema_version: z.number(),
		name: z.string(),
		description: z.string(),
		app: z.string().nullish(),
		params: recipeMap(recipeParamSchema).nullish(),
		preconditions: recipeResponse(
			z.object({
				app_running: z.string().nullish(),
				url_contains: z.string().nullish(),
			})
		).nullish(),
		steps: z.array(recipeStepSchema),
		on_failure: z.string().nullish(),
	})
);
const recipeSummarySchema = recipeResponse(
	z.object({
		app: z.string().nullable(),
		description: z.string(),
		name: z.string(),
		params: z.array(z.string()),
		step_count: z.number(),
	})
);
const recipeListResponseSchema = recipeResponse(
	z.object({ recipes: z.array(recipeSummarySchema).nullish() })
);
const recipeGetResponseSchema = recipeResponse(
	z.object({ recipe: recipeResponseSchema })
);
const recipeSaveResponseSchema = recipeResponse(
	z.object({
		name: z.string(),
		saved: z.boolean(),
		recipe: recipeResponseSchema,
	})
);
const recipeDeleteResponseSchema = recipeResponse(
	z.object({ name: z.string(), deleted: z.boolean() })
);
const recipeStepResultSchema = recipeResponse(
	z.object({
		action: z.string(),
		duration_ms: z.number(),
		error: z.string().nullish(),
		note: z.string().nullish(),
		step_id: z.number(),
		success: z.boolean(),
	})
);
export const recipeRunResultResponseSchema = recipeResponse(
	z.object({
		error: z.string().nullish(),
		recipe_name: z.string(),
		step_results: z.array(recipeStepResultSchema),
		steps_completed: z.number(),
		success: z.boolean(),
		total_steps: z.number(),
	})
);
const recipeRunResponseSchema = recipeResponse(
	z.object({ result: recipeRunResultResponseSchema })
);
const learnedEventSchema = recipeResponse(
	z.object({
		app_name: z.string().nullish(),
		element_id: z.string().nullish(),
		element_name: z.string().nullish(),
		element_role: z.string().nullish(),
		event_type: z.string(),
		key: z.string().nullish(),
		ts_ms: z.number(),
		x: z.number().nullish(),
		y: z.number().nullish(),
	})
);
export const recordingStateResponseSchema = recipeResponse(
	z.object({
		recording: z.boolean(),
		started_at: z.string().optional(),
		status: appJsonValueSchema.optional(),
		info: appJsonValueSchema.optional(),
		task: z.string().optional(),
	})
);
export const recordingStopResponseSchema = recipeResponse(
	z.object({
		draft: recipeResponseSchema.optional(),
		event_count: z.number(),
		events: z.array(learnedEventSchema),
		recording: z.literal(false),
		started_at: z.string(),
		suggestion: z.string().optional(),
		task: z.string(),
	})
);

/** A recipe row in the list view (summary form). */
export interface RecipeSummary {
	app: string | null;
	description: string;
	name: string;
	/** The recipe's declared `{{param}}` slots. */
	params: string[];
	step_count: number;
}

/** A recipe parameter declaration. */
export interface RecipeParam {
	description: string;
	required?: boolean | null;
	type: string;
}

/** An element locator used by a recipe step. */
export interface RecipeLocator {
	app?: string | null;
	dom_class?: string | null;
	dom_id?: string | null;
	identifier?: string | null;
	query?: string | null;
	role?: string | null;
}

/** A full native wait condition declared on a recipe step. */
export interface RecipeWaitCondition {
	condition: string;
	target?: RecipeLocator | null;
	timeout?: number | null;
	value?: string | null;
}

/** A single recorded step. */
export interface RecipeStep {
	action: string;
	id: number;
	note?: string | null;
	on_failure?: string | null;
	params?: Record<string, string> | null;
	target?: RecipeLocator | null;
	wait_after?: RecipeWaitCondition | null;
}

/** A full recipe definition (ghost-os v2 schema). */
export interface Recipe {
	app?: string | null;
	description: string;
	name: string;
	on_failure?: string | null;
	params?: Record<string, RecipeParam> | null;
	preconditions?: {
		app_running?: string | null;
		url_contains?: string | null;
	} | null;
	schema_version: number;
	steps: RecipeStep[];
}

/** Per-step outcome from a replay. */
export interface RecipeStepResult {
	action: string;
	duration_ms: number;
	error?: string | null;
	note?: string | null;
	step_id: number;
	success: boolean;
}

/** Result of replaying a recipe. */
export interface RecipeRunResult {
	error?: string | null;
	recipe_name: string;
	step_results: RecipeStepResult[];
	steps_completed: number;
	success: boolean;
	total_steps: number;
}

/** Live recording status. */
export interface RecordingState {
	/** Native ghost recorder-start information. */
	info?: AppJsonValue;
	recording: boolean;
	started_at?: string;
	/** Raw `ghost_learn_status` payload while recording (event count, elapsed). */
	status?: AppJsonValue;
	task?: string;
}

/** A single captured action event (AX-enriched at record time). */
export interface LearnedEvent {
	app_name?: string | null;
	element_id?: string | null;
	element_name?: string | null;
	element_role?: string | null;
	/** click | type | hotkey | scroll | press | app_switch. */
	event_type: string;
	/** For key/type events: the key name or typed text. */
	key?: string | null;
	ts_ms: number;
	x?: number | null;
	y?: number | null;
}

/** Result of stopping a recording — the captured AX-enriched action sequence. */
export interface RecordingStopResult {
	/** Editable recipe draft Core scaffolds from the events. Older Core builds
	 * omit it — fall back to {@link draftRecipeFromEvents} then. */
	draft?: Recipe;
	event_count: number;
	events: LearnedEvent[];
	recording: false;
	started_at: string;
	suggestion?: string;
	task: string;
}

export async function listRecipes(target: ApiTarget): Promise<RecipeSummary[]> {
	const json = await request(
		target,
		"/api/recipes",
		{},
		recipeListResponseSchema
	);
	return json.recipes ?? [];
}

export async function getRecipe(
	target: ApiTarget,
	name: string
): Promise<Recipe> {
	const json = await request(
		target,
		`/api/recipes/${encodeURIComponent(name)}`,
		{},
		recipeGetResponseSchema
	);
	return json.recipe;
}

export async function saveRecipe(
	target: ApiTarget,
	recipe: Recipe
): Promise<string> {
	const json = await request(
		target,
		"/api/recipes",
		{
			method: "POST",
			body: { recipe },
		},
		recipeSaveResponseSchema
	);
	return json.name;
}

export async function deleteRecipe(
	target: ApiTarget,
	name: string
): Promise<void> {
	await request(
		target,
		`/api/recipes/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		recipeDeleteResponseSchema
	);
}

export async function runRecipe(
	target: ApiTarget,
	name: string,
	params: Record<string, string>
): Promise<RecipeRunResult> {
	const json = await request(
		target,
		`/api/recipes/${encodeURIComponent(name)}/run`,
		{ method: "POST", body: { params } },
		recipeRunResponseSchema
	);
	return json.result;
}

/** Slugify a task description into a safe recipe name. */
function slugify(task: string): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	return slug || "recorded-recipe";
}

/**
 * Build an editable recipe draft from a captured action sequence. Core now owns
 * this transform and returns the draft from `record/stop` (so every client gets
 * the same scaffold); this remains only as an OFFLINE FALLBACK for older Core
 * builds that don't return a `draft`. Each event maps to a step using its AX
 * context as the locator; typed text becomes a `type` step the user can
 * parameterize with `{{param}}`.
 */
export function draftRecipeFromEvents(
	task: string,
	events: LearnedEvent[]
): Recipe {
	const steps: RecipeStep[] = events.map((e, i): RecipeStep => {
		const id = i + 1;
		const target: RecipeLocator | null =
			e.element_name || e.element_role || e.element_id || e.app_name
				? {
						query: e.element_name ?? null,
						role: e.element_role ?? null,
						identifier: e.element_id ?? null,
						app: e.app_name ?? null,
					}
				: null;
		switch (e.event_type) {
			case "type":
				return { id, action: "type", target, params: { text: e.key ?? "" } };
			case "press":
				return { id, action: "press", params: { key: e.key ?? "" } };
			case "hotkey":
				return { id, action: "hotkey", params: { keys: e.key ?? "" } };
			case "scroll":
				return { id, action: "scroll", params: { direction: e.key ?? "down" } };
			case "app_switch":
				return { id, action: "focus", params: { app: e.app_name ?? "" } };
			default:
				return {
					id,
					action: "click",
					target,
					note: e.element_name ?? undefined,
				};
		}
	});
	return {
		schema_version: 2,
		name: slugify(task),
		description: task || "Recorded workflow",
		app: events.find((e) => e.app_name)?.app_name ?? null,
		params: {},
		steps,
		on_failure: "abort",
	};
}

export async function startRecording(
	target: ApiTarget,
	task: string
): Promise<RecordingState> {
	return await request(
		target,
		"/api/recipes/record/start",
		{
			method: "POST",
			body: { task },
		},
		recordingStateResponseSchema
	);
}

export async function getRecordingStatus(
	target: ApiTarget
): Promise<RecordingState> {
	return await request(
		target,
		"/api/recipes/record/status",
		{},
		recordingStateResponseSchema
	);
}

export async function stopRecording(
	target: ApiTarget
): Promise<RecordingStopResult> {
	return await request(
		target,
		"/api/recipes/record/stop",
		{ method: "POST" },
		recordingStopResponseSchema
	);
}
