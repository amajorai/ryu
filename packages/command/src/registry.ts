// Command registry: the pluggable-action layer the desktop palette never had.
//
// `groupActions` is the pure grouping the palette renders with (first-seen group
// order, stable within a group). `useCommandRegistry` is an optional imperative
// store for consumers that register actions from many places (the command bar,
// future plugins) instead of building one declarative array.

import { useCallback, useMemo, useState } from "react";
import type { CommandAction } from "./types.ts";

/** A heading plus the actions filed under it, in insertion order. */
export interface CommandActionGroup {
	actions: CommandAction[];
	heading: string;
}

/**
 * Bucket a flat action list into ordered groups. Group order follows first
 * appearance; action order within a group follows the input. Pure + tested.
 */
export function groupActions(actions: CommandAction[]): CommandActionGroup[] {
	const groups: CommandActionGroup[] = [];
	const byHeading = new Map<string, CommandActionGroup>();
	for (const action of actions) {
		let group = byHeading.get(action.group);
		if (!group) {
			group = { heading: action.group, actions: [] };
			byHeading.set(action.group, group);
			groups.push(group);
		}
		group.actions.push(action);
	}
	return groups;
}

/**
 * Compute the cmdk search value for an action: the explicit `value` when set,
 * else `"<group> <title> <keywords>"`. Pure + tested.
 */
export function actionSearchValue(action: CommandAction): string {
	if (action.value) {
		return action.value;
	}
	return [action.group, action.title, action.keywords]
		.filter(Boolean)
		.join(" ");
}

/** Handle returned by `useCommandRegistry`. */
export interface CommandRegistry {
	/** All registered actions, in registration order. */
	actions: CommandAction[];
	/** Register one or more actions; returns a function that removes them. */
	register(...actions: CommandAction[]): () => void;
}

/**
 * Imperative action store for consumers that contribute commands from multiple
 * sources. Registration order is preserved; `register` returns an unregister so
 * a contributor can clean up on unmount.
 */
export function useCommandRegistry(
	initial: CommandAction[] = []
): CommandRegistry {
	const [actions, setActions] = useState<CommandAction[]>(initial);

	const register = useCallback((...added: CommandAction[]): (() => void) => {
		setActions((prev) => [...prev, ...added]);
		const addedIds = new Set(added.map((action) => action.id));
		return () =>
			setActions((prev) => prev.filter((action) => !addedIds.has(action.id)));
	}, []);

	return useMemo(() => ({ actions, register }), [actions, register]);
}
