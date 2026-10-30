import { z } from "zod";

export const defaultsResponseSchema = z.looseObject({
	coordinatorEffort: z.string().optional(),
	coordinatorModel: z.string().optional(),
	coordinatorProvider: z.string().optional(),
	effort: z.string(),
	model: z.string(),
	provider: z.string(),
});

export type OwnerKind = "agent" | "group" | "project";

/**
 * One scope's model default. Empty strings mean "not set at this level".
 *
 * `provider`/`model`/`effort` are the thread defaults (every thread in the
 * scope). The `coordinator*` fields override them for main threads only.
 */
export interface ScopeDefault {
	coordinatorEffort?: string;
	coordinatorModel?: string;
	coordinatorProvider?: string;
	effort: string;
	model: string;
	provider: string;
}

/** Which defaults a thread reads: main threads coordinate, sessions work. */
export type DefaultsRole = "coordinator" | "thread";

/** The node-wide scope set in Settings › Models. */
export const GLOBAL_SCOPE = "global";

/** The level a resolved default came from, most specific first. */
export type DefaultSource =
	| "session"
	| "project_agent"
	| "agent"
	| "agent_binding"
	| "project"
	| "settings"
	| "global";

export interface ResolvedDefault {
	effort: string;
	effort_source: DefaultSource | null;
	model: string;
	model_source: DefaultSource | null;
	provider: string;
}

export interface EffectiveDefaults {
	levels: {
		agent: ScopeDefault | null;
		agent_binding_model: string | null;
		global: ScopeDefault | null;
		project: ScopeDefault | null;
		project_agent: ScopeDefault | null;
		session: ScopeDefault | null;
		settings: ScopeDefault | null;
	};
	resolved: ResolvedDefault;
}

export const EMPTY_SCOPE_DEFAULT: ScopeDefault = {
	effort: "",
	model: "",
	provider: "",
};
