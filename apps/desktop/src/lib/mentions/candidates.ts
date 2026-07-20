// Builds the grouped, filtered candidate list for the composer "@" menu, and
// applies a chosen mention back into the composer text. Pure functions — the
// menu component owns keyboard/dismiss state, ChatPage owns the data sources.
// See docs/rfc-mention-composer.md.

import {
	IconDatabase,
	IconFolder,
	IconPlug,
	IconRobot,
	IconSparkles,
	IconUsers,
} from "@tabler/icons-react";
import type {
	ComposerPlugin,
	MentionGroup,
	MentionItem,
	MentionSources,
} from "./types.ts";

const PATH_SEPARATOR = /[\\/]/;
/** The in-progress "@word" fragment at the cursor (after start or whitespace). */
const TRAILING_MENTION = /(?<=(?:^|\s))@\w*$/;
/** Cap per section so the menu stays scannable; refine with search instead. */
const MAX_PER_GROUP = 6;

/** Last path segment of a folder path (the folder's display name). */
function basename(path: string): string {
	const parts = path.split(PATH_SEPARATOR).filter(Boolean);
	return parts.at(-1) ?? path;
}

/**
 * Group the mention sources into labelled sections, filtered by `query`
 * (case-insensitive substring) and capped per section. Order puts the two
 * targeting mentions (agents, teams) first, then plugins, then context refs.
 */
export function buildMentionGroups(
	sources: MentionSources,
	query: string
): MentionGroup[] {
	const q = query.trim().toLowerCase();
	const matches = (...fields: string[]) =>
		q === "" || fields.some((f) => f.toLowerCase().includes(q));
	const groups: MentionGroup[] = [];

	const add = (
		kind: MentionGroup["kind"],
		label: string,
		items: MentionItem[]
	) => {
		if (items.length > 0) {
			groups.push({ kind, label, items: items.slice(0, MAX_PER_GROUP) });
		}
	};

	add(
		"agent",
		"Agents",
		sources.agents
			.filter((a) => matches(a.name))
			.map((a) => ({ kind: "agent", id: a.id, label: a.name, icon: IconRobot }))
	);
	add(
		"team",
		"Teams",
		sources.teams
			.filter((t) => matches(t.name))
			.map((t) => ({ kind: "team", id: t.id, label: t.name, icon: IconUsers }))
	);
	add(
		"plugin",
		"Plugins",
		sources.plugins
			.filter((p) => matches(p.name, p.id))
			.map((p) => ({
				kind: "plugin",
				id: p.id,
				label: p.name,
				description: p.description,
				icon: p.icon,
				plugin: p,
			}))
	);
	add(
		"skill",
		"Skills",
		sources.skills
			.filter((s) => matches(s.name))
			.map((s) => ({
				kind: "skill",
				id: s.id,
				label: s.name,
				icon: IconSparkles,
			}))
	);
	add(
		"mcp",
		"MCP",
		sources.mcp
			.filter((m) => matches(m.name))
			.map((m) => ({ kind: "mcp", id: m.id, label: m.name, icon: IconPlug }))
	);
	add(
		"space",
		"Spaces",
		sources.spaces
			.filter((s) => matches(s.name))
			.map((s) => ({
				kind: "space",
				id: s.id,
				label: s.name,
				icon: IconDatabase,
			}))
	);
	add(
		"folder",
		"Folders",
		sources.folders
			.filter((f) => matches(basename(f), f))
			.map((f) => ({
				kind: "folder",
				id: f,
				label: basename(f),
				description: f,
				icon: IconFolder,
			}))
	);

	return groups;
}

/** Flatten grouped candidates into a single ordered list for keyboard nav. */
export function flattenGroups(groups: MentionGroup[]): MentionItem[] {
	return groups.flatMap((g) => g.items);
}

/** Rewrite the composer to its slash command / canned prompt for a plugin. */
function applyPlugin(value: string, plugin: ComposerPlugin): string {
	// Drop the "@fragment" the user typed to pick the plugin; keep the rest.
	const rest = value.replace(TRAILING_MENTION, "").trim();
	if (plugin.action.type === "slash") {
		const cmd = `/${plugin.action.name}`;
		return rest ? `${cmd} ${rest} ` : `${cmd} `;
	}
	return rest ? `${rest} ${plugin.action.text} ` : `${plugin.action.text} `;
}

/**
 * Apply a chosen mention back into the composer value. Entity mentions replace
 * the trailing "@fragment" with an "@Label " token; plugins rewrite via their
 * action (slash command or canned prompt).
 */
export function applyMention(value: string, item: MentionItem): string {
	if (item.kind === "plugin" && item.plugin) {
		return applyPlugin(value, item.plugin);
	}
	return value.replace(TRAILING_MENTION, `@${item.label} `);
}
