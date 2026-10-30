// apps/desktop/src/components/store/InstalledSection-categories.ts
//
// Runnable-kind labels, card copy, and the installed-tab category grouping for
// the Store's Installed section.

import type { AppInfo } from "@/src/lib/api/plugins.ts";

export const AGENT_KIND = "agent";

export const KIND_LABELS = new Map<string, string>([
	["agent", "Agent"],
	["workflow", "Workflow"],
	["tool", "Tool"],
	["skill", "Skill"],
	["companion", "Companion"],
	["channel", "Channel"],
	["engine", "Engine"],
	["policy", "Policy"],
]);

export function primaryAgentId(app: AppInfo): string | null {
	const entry = app.runnables.find((r) => r.kind === AGENT_KIND);
	return entry?.id ?? null;
}

/** The version that is ACTUALLY ON THIS MACHINE.
 *
 *  `app.version` is the MANIFEST's version — for an install that has fallen behind
 *  its manifest that is the newer number, so a card rendering it claims a version
 *  the user does not have. The lifecycle record's `installedVersion` is the truth,
 *  and it is null for a built-in (which has no record) and for anything not yet
 *  installed — hence coalesce, never swap. */
export function installedVersionOf(app: AppInfo): string {
	return app.installedVersion ?? app.version;
}

/** The one-line card description.
 *
 *  `tagline` is the manifest's short pitch and `description` its long
 *  plaintext/markdown body; the card slot truncates to a single line, so the
 *  tagline wins and the description is only a fallback. Before this the slot
 *  carried the version string — which the stat strip already states twice — so
 *  every installed row read "v1.0.0" and said nothing about what the app does. */
export function cardDescription(app: AppInfo): string | null {
	const text = app.tagline?.trim() || app.description?.trim();
	if (text) {
		return text;
	}
	return app.builtIn ? "Built-in system app." : null;
}

/** The installed-tab category an app belongs to, derived from what it bundles.
 *  Built-ins are their own "System" group; everything else is keyed by its
 *  dominant runnable kind so the grid reads as one section per kind. */
export type InstalledCategory =
	| "apps"
	| "agents"
	| "tools"
	| "skills"
	| "workflows"
	| "channels"
	| "policies"
	| "plugins"
	| "system";

export const CATEGORY_ORDER: InstalledCategory[] = [
	"apps",
	"agents",
	"tools",
	"skills",
	"workflows",
	"channels",
	"policies",
	"plugins",
	"system",
];

export const CATEGORY_LABELS = {
	apps: "Apps",
	agents: "Agents",
	tools: "Tools",
	skills: "Skills",
	workflows: "Workflows",
	channels: "Channels",
	policies: "Policies",
	plugins: "Plugins",
	system: "System",
} satisfies Record<InstalledCategory, string>;

export function appCategory(app: AppInfo): InstalledCategory {
	// "System" is exactly what Core refuses to uninstall (`app.system`), plus the
	// sidecar-managed built-ins that have no lifecycle record of their own.
	if (app.builtIn || app.system) {
		return "system";
	}
	const kinds = new Set(app.runnables.map((r) => r.kind));
	if (kinds.has("companion")) {
		return "apps";
	}
	if (kinds.has("agent")) {
		return "agents";
	}
	if (kinds.has("skill")) {
		return "skills";
	}
	if (kinds.has("workflow")) {
		return "workflows";
	}
	if (kinds.has("channel")) {
		return "channels";
	}
	if (kinds.has("policy")) {
		return "policies";
	}
	if (kinds.has("tool")) {
		return "tools";
	}
	return "plugins";
}
