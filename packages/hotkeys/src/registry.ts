// The action registry for Ryu's unified hotkey system.
//
// A surface declares its bindable actions once (id, label, category, default
// chord). User customizations live in a separate `Overrides` map so defaults are
// never mutated — a reset is just deleting the override, and "clear" is an
// explicit `null` (bound to nothing). Resolution merges the two.

import type { Chord } from "./chord.ts";
import { normalizeChord } from "./chord.ts";

/** One user-bindable action. */
export interface HotkeyAction {
	/** The group heading this action sorts under, e.g. `"Tabs"`. */
	category: string;
	/** The chord bound out of the box, or `null` for "unbound by default". */
	defaultBinding: Chord | null;
	/** Optional longer description shown as help text. */
	description?: string;
	/**
	 * When true this is an OS-level global shortcut managed by the native layer
	 * (Electron/Tauri) rather than the webview key handler. The settings UI still
	 * lists it; the runtime handler dispatch ignores it.
	 */
	global?: boolean;
	/** Stable, kebab-case identifier, e.g. `"tab.new"`. */
	id: string;
	/** Human label shown in the settings table. */
	label: string;
}

/** The declared set of actions for a surface. */
export type HotkeyRegistry = HotkeyAction[];

/**
 * User customizations, keyed by action id. A `string` rebinds the action; an
 * explicit `null` clears it (bound to nothing); an absent key means "use the
 * action's default".
 */
export type Overrides = Record<string, Chord | null>;

/** Resolve the effective binding for one action given the user's overrides. */
export function resolveBinding(
	action: HotkeyAction,
	overrides: Overrides
): Chord | null {
	if (Object.hasOwn(overrides, action.id)) {
		const override = overrides[action.id];
		return override ? normalizeChord(override) : null;
	}
	return action.defaultBinding === null
		? null
		: normalizeChord(action.defaultBinding);
}

/** Resolve every action's effective binding into an id -> chord map. */
export function resolveAllBindings(
	registry: HotkeyRegistry,
	overrides: Overrides
): Map<string, Chord | null> {
	const map = new Map<string, Chord | null>();
	for (const action of registry) {
		map.set(action.id, resolveBinding(action, overrides));
	}
	return map;
}

/**
 * Find chords bound to more than one action. Returns a map of chord -> the ids
 * that share it, so the settings UI can flag conflicts. Unbound actions (null)
 * never conflict.
 */
export function findConflicts(
	registry: HotkeyRegistry,
	overrides: Overrides
): Map<Chord, string[]> {
	const byChord = new Map<Chord, string[]>();
	for (const action of registry) {
		const binding = resolveBinding(action, overrides);
		if (binding === null) {
			continue;
		}
		const existing = byChord.get(binding);
		if (existing) {
			existing.push(action.id);
		} else {
			byChord.set(binding, [action.id]);
		}
	}
	const conflicts = new Map<Chord, string[]>();
	for (const [chord, ids] of byChord) {
		if (ids.length > 1) {
			conflicts.set(chord, ids);
		}
	}
	return conflicts;
}

/** A category and the actions that belong to it, in declaration order. */
export interface HotkeyCategory {
	actions: HotkeyAction[];
	category: string;
}

/** Group a registry by category, preserving first-seen category order. */
export function groupByCategory(registry: HotkeyRegistry): HotkeyCategory[] {
	const groups: HotkeyCategory[] = [];
	const index = new Map<string, HotkeyCategory>();
	for (const action of registry) {
		let group = index.get(action.category);
		if (!group) {
			group = { category: action.category, actions: [] };
			index.set(action.category, group);
			groups.push(group);
		}
		group.actions.push(action);
	}
	return groups;
}
