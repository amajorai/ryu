// apps/desktop/src/lib/model-defaults.ts
//
// Pure helpers for the coordinator/thread model defaults.
//
// Every scope (Settings › Models, a project, a bot, a bot in a project) stores
// two sets of defaults: the THREAD values (`provider`/`model`/`effort`) every
// session reads, and the COORDINATOR values (`coordinator*`) that override them
// for main threads. Core resolves the cascade at turn time; these helpers only
// shape values for the pickers and label what a blank picker inherits.

import type {
	DefaultsRole,
	EffectiveDefaults,
	ScopeDefault,
} from "./api/hierarchy.ts";

/** One role's view of a scope: what that role's pickers read and write. */
export interface RoleDefault {
	effort: string;
	model: string;
	provider: string;
}

export const EMPTY_ROLE_DEFAULT: RoleDefault = {
	effort: "",
	model: "",
	provider: "",
};

/** The values one role's pickers show for a stored scope. */
export function roleValue(
	value: ScopeDefault | null | undefined,
	role: DefaultsRole
): RoleDefault {
	if (!value) {
		return EMPTY_ROLE_DEFAULT;
	}
	if (role === "coordinator") {
		return {
			effort: value.coordinatorEffort ?? "",
			model: value.coordinatorModel ?? "",
			provider: value.coordinatorProvider ?? "",
		};
	}
	return {
		effort: value.effort,
		model: value.model,
		provider: value.provider,
	};
}

/** `value` with one role's fields replaced by `next`. */
export function withRoleValue(
	value: ScopeDefault,
	role: DefaultsRole,
	next: Partial<RoleDefault>
): ScopeDefault {
	const current = roleValue(value, role);
	const merged = { ...current, ...next };
	if (role === "coordinator") {
		return {
			...value,
			coordinatorEffort: merged.effort,
			coordinatorModel: merged.model,
			coordinatorProvider: merged.provider,
		};
	}
	return {
		...value,
		effort: merged.effort,
		model: merged.model,
		provider: merged.provider,
	};
}

/** Whether a scope stores anything at all (for "Reset to inherited"). */
export function isScopeSet(value: ScopeDefault | null | undefined): boolean {
	if (!value) {
		return false;
	}
	return [
		value.provider,
		value.model,
		value.effort,
		value.coordinatorProvider,
		value.coordinatorModel,
		value.coordinatorEffort,
	].some((field) => Boolean(field?.trim()));
}

/** The stored levels of the cascade, most specific first. */
export type StoredLevel = "project_agent" | "agent" | "project" | "settings";

/**
 * The cascade below `level`, in Core's order. The agent card's own model sits
 * between the bot levels and the project (`agent_binding_model`), and the lane
 * default (`global`) is last.
 */
const ORDER: readonly (StoredLevel | "agent_binding" | "global")[] = [
	"project_agent",
	"agent",
	"agent_binding",
	"project",
	"settings",
	"global",
];

/**
 * What a blank picker at `level` inherits, read from the role-reduced levels
 * of `GET /api/hierarchy/effective-defaults`. Model and effort fall through on
 * their own, as in Core.
 */
export function inheritedBelow(
	levels: EffectiveDefaults["levels"] | null | undefined,
	level: StoredLevel
): RoleDefault {
	return inheritedFrom(levels, ORDER.indexOf(level) + 1, {
		effort: false,
		model: false,
	});
}

/**
 * What a blank Coordinator picker at `level` inherits. The coordinator levels
 * come reduced from Core: when no level stores a coordinator value, a main
 * thread reads each level's THREAD values, this level's own included. So
 * unless this scope stores its own coordinator value (which a blank picker is
 * about to drop), its reduced level is what the main thread falls back to
 * first.
 */
export function inheritedForCoordinator(
	levels: EffectiveDefaults["levels"] | null | undefined,
	level: StoredLevel,
	stored: ScopeDefault | null | undefined
): RoleDefault {
	return inheritedFrom(levels, ORDER.indexOf(level), {
		effort: Boolean(stored?.coordinatorEffort?.trim()),
		model: Boolean(stored?.coordinatorModel?.trim()),
	});
}

function inheritedFrom(
	levels: EffectiveDefaults["levels"] | null | undefined,
	start: number,
	skipFirst: { effort: boolean; model: boolean }
): RoleDefault {
	if (!levels) {
		return EMPTY_ROLE_DEFAULT;
	}
	let model = "";
	let provider = "";
	let effort = "";
	for (const [index, key] of ORDER.entries()) {
		if (index < start) {
			continue;
		}
		const isFirst = index === start;
		if (key === "agent_binding") {
			if (!model && levels.agent_binding_model?.trim()) {
				model = levels.agent_binding_model.trim();
			}
			continue;
		}
		const entry = levels[key];
		if (!entry) {
			continue;
		}
		if (!(model || (isFirst && skipFirst.model)) && entry.model.trim()) {
			model = entry.model.trim();
			provider = entry.provider.trim();
		}
		if (!(effort || (isFirst && skipFirst.effort)) && entry.effort.trim()) {
			effort = entry.effort.trim();
		}
	}
	return { effort, model, provider };
}

/** "Default (Opus 5.5)", or plain "Default" when nothing below is set. */
export function defaultLabel(inherited: string): string {
	return inherited ? `Default (${inherited})` : "Default";
}

/** "medium" → "Medium". */
export function effortLabel(effort: string): string {
	return effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : effort;
}
