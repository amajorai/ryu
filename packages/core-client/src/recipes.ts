// apps/desktop/src/lib/api/recipes.ts
//
// Typed client for the Core ghost-recipes surface (`/api/recipes/*`): the
// record / list / show / run / delete flow that gives Ryu's workflow system
// ghost-os parity. A recipe is a parameterized, recorded native-desktop
// automation — a frontier model records it once, a small model (or a workflow)
// replays it forever. All logic is in Core; this is a thin transport layer over
// the shared {@link request} plumbing (base URL + bearer come from the node).

import { type ApiTarget, request } from "./client.ts";

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
	required?: boolean;
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

/** A single recorded step. */
export interface RecipeStep {
	action: string;
	id: number;
	note?: string | null;
	on_failure?: string | null;
	params?: Record<string, string> | null;
	target?: RecipeLocator | null;
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
	recording: boolean;
	started_at?: string;
	/** Raw `ghost_learn_status` payload while recording (event count, elapsed). */
	status?: unknown;
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
	const json = await request<{ recipes?: RecipeSummary[] }>(
		target,
		"/api/recipes"
	);
	return json.recipes ?? [];
}

export async function getRecipe(
	target: ApiTarget,
	name: string
): Promise<Recipe> {
	const json = await request<{ recipe: Recipe }>(
		target,
		`/api/recipes/${encodeURIComponent(name)}`
	);
	return json.recipe;
}

export async function saveRecipe(
	target: ApiTarget,
	recipe: Recipe
): Promise<string> {
	const json = await request<{ name: string }>(target, "/api/recipes", {
		method: "POST",
		body: { recipe },
	});
	return json.name;
}

export async function deleteRecipe(
	target: ApiTarget,
	name: string
): Promise<void> {
	await request<unknown>(target, `/api/recipes/${encodeURIComponent(name)}`, {
		method: "DELETE",
	});
}

export async function runRecipe(
	target: ApiTarget,
	name: string,
	params: Record<string, string>
): Promise<RecipeRunResult> {
	const json = await request<{ result: RecipeRunResult }>(
		target,
		`/api/recipes/${encodeURIComponent(name)}/run`,
		{ method: "POST", body: { params } }
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
	return await request<RecordingState>(target, "/api/recipes/record/start", {
		method: "POST",
		body: { task },
	});
}

export async function getRecordingStatus(
	target: ApiTarget
): Promise<RecordingState> {
	return await request<RecordingState>(target, "/api/recipes/record/status");
}

export async function stopRecording(
	target: ApiTarget
): Promise<RecordingStopResult> {
	return await request<RecordingStopResult>(
		target,
		"/api/recipes/record/stop",
		{ method: "POST" }
	);
}
