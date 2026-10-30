import type {
	Choice,
	DeclaredLevel,
	Overwrite,
	PermissionGroup,
	PrincipalDirectory,
	Setting,
	TargetType,
	Vocabulary,
} from "./ResourcePermissions-types.ts";

export const SETTING_LABEL = {
	allow: "Allow",
	deny: "Deny",
	inherit: "Inherit",
} satisfies Record<Setting, string>;

export const SETTING_ORDER = ["deny", "inherit", "allow"] as const;

export function settingOf(row: Overwrite, permission: string): Setting {
	if (row.deny.includes(permission)) {
		return "deny";
	}
	if (row.allow.includes(permission)) {
		return "allow";
	}
	return "inherit";
}

/**
 * Apply a tri-state choice, keeping allow/deny mutually exclusive.
 *
 * "Inherit" removes the permission from BOTH lists rather than writing an empty
 * marker — the node treats absence as "fall through to the role", so an explicit
 * neutral entry would be a rule that looks set but does nothing.
 */
export function withSetting(
	row: Overwrite,
	permission: string,
	setting: Setting
): Overwrite {
	const allow = row.allow.filter((p) => p !== permission);
	const deny = row.deny.filter((p) => p !== permission);
	if (setting === "allow") {
		allow.push(permission);
	}
	if (setting === "deny") {
		deny.push(permission);
	}
	return { ...row, allow, deny };
}

export const TARGET_LABEL = {
	org: "Everyone in the org",
	team: "Team",
	role: "Role",
	member: "Person",
} satisfies Record<TargetType, string>;

export const TARGET_PLACEHOLDER = {
	org: "",
	team: "Choose a team",
	role: "Choose a role",
	member: "Choose a person",
} satisfies Record<TargetType, string>;

export const TARGET_FALLBACK_PLACEHOLDER = {
	org: "",
	team: "Team identifier",
	role: "Role identifier",
	member: "Person's identifier",
} satisfies Record<TargetType, string>;

/** What the node would have listed, for the message shown when it listed none. */
export const TARGET_PLURAL = {
	org: "",
	team: "teams",
	role: "roles",
	member: "people",
} satisfies Record<TargetType, string>;

/**
 * A readable name for the app a permission came from.
 *
 * Derived from the id rather than looked up in the installed-apps list on
 * purpose: a heading is not worth a second data dependency that can fail, and an
 * app that publishes levels may not be one this desktop can name.
 */
export function sourceTitle(pluginId: string): string {
	const last = pluginId.split(".").at(-1) ?? pluginId;
	const spaced = last.replace(/[-_]/g, " ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Everything reachable from `seed`, seed excluded.
 *
 * Breadth-first with a visited set, mirroring Core's own walk: the graph is
 * assembled from many manifests, so nothing guarantees it is acyclic even though
 * each manifest is validated on its own.
 */
export function closureFrom(
	seed: string,
	edges: Map<string, string[]>
): string[] {
	const seen = new Set<string>([seed]);
	const queue = [seed];
	for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
		for (const next of edges.get(id) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	seen.delete(seed);
	return [...seen];
}

/**
 * The permission list, grouped by source and with implications resolved.
 *
 * Two rules here come straight from the node and are not cosmetic:
 *
 * - An app that names a built-in key keeps its wording but loses its edges — the
 *   node drops them and reports the id in `collisions` — so the key is filed
 *   under the built-ins and its declared `implies` is ignored. Drawing those
 *   edges would promise an expansion the node does not perform. Core likewise
 *   drops (and reports) an app level's edges into a built-in key or another
 *   app's level, and strips them from that level's `implies` before serving it.
 * - An edge pointing at an id nothing declared is dropped, again matching Core:
 *   an unknown id must not be able to widen a known one.
 */
export function buildGroups(vocabulary: Vocabulary | null): PermissionGroup[] {
	if (!vocabulary) {
		return [];
	}
	const builtIn = new Set(vocabulary.kernel);
	const byId = new Map<string, DeclaredLevel>();
	for (const level of vocabulary.declared) {
		byId.set(level.id, level);
	}
	const ids = new Set<string>([...builtIn, ...byId.keys()]);

	const allows = new Map<string, string[]>();
	const denies = new Map<string, string[]>();
	const addEdge = (edges: Map<string, string[]>, from: string, to: string) => {
		const existing = edges.get(from);
		if (existing) {
			existing.push(to);
			return;
		}
		edges.set(from, [to]);
	};
	for (const level of vocabulary.declared) {
		if (builtIn.has(level.id)) {
			continue;
		}
		for (const implied of level.implies) {
			if (!ids.has(implied)) {
				continue;
			}
			addEdge(allows, level.id, implied);
			addEdge(denies, implied, level.id);
		}
	}

	// A kernel key with no app-supplied label falls back to its own id: the id is
	// a poor label, but showing nothing would make a real permission unselectable.
	const labelOf = (id: string) => byId.get(id)?.label ?? id;
	const grouped = new Map<string, PermissionGroup>();
	for (const id of [...ids].sort()) {
		const level = byId.get(id);
		const key = level && !builtIn.has(id) ? level.plugin_id : "";
		const group = grouped.get(key) ?? {
			key,
			title: key ? sourceTitle(key) : "Built in",
			permissions: [],
		};
		group.permissions.push({
			id,
			label: labelOf(id),
			description: level?.description ?? "",
			alsoAllows: closureFrom(id, allows).map(labelOf).sort(),
			alsoDenies: closureFrom(id, denies).map(labelOf).sort(),
		});
		grouped.set(key, group);
	}

	// Built-ins first: they are the keys every node has, and the ones an admin
	// setting up a space is looking for.
	return [...grouped.values()].sort((a, b) => {
		if (a.key === b.key) {
			return 0;
		}
		if (a.key === "") {
			return -1;
		}
		if (b.key === "") {
			return 1;
		}
		return a.title.localeCompare(b.title);
	});
}

export function choicesFor(
	directory: PrincipalDirectory | null,
	targetType: TargetType
): Choice[] {
	if (!directory) {
		return [];
	}
	if (targetType === "role") {
		return directory.roles.map((r) => ({ id: r.id, label: r.label || r.id }));
	}
	if (targetType === "team") {
		return directory.teams.map((t) => ({ id: t.id, label: t.name || t.id }));
	}
	if (targetType === "member") {
		return directory.members.map((m) => ({
			id: m.id,
			label: m.name || m.email || m.id,
			hint: m.email ?? undefined,
		}));
	}
	return [];
}
