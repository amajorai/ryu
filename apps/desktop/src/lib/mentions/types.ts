// The typed model behind the composer's "@" mention system. A Mention is a typed
// reference the user drops into the chat composer — an agent, team, space, skill,
// MCP server, project folder, or a composer *plugin* (an action like goal /
// double-check). See docs/rfc-mention-composer.md for the full design.

import type { ComponentType } from "react";

export type MentionKind =
	| "agent"
	| "team"
	| "space"
	| "skill"
	| "mcp"
	| "folder"
	| "plugin";

/** A single, resolved mention candidate shown in the "@" menu. */
export interface MentionItem {
	/** Optional secondary line (e.g. a skill description or folder path). */
	description?: string;
	/** Icon for the row. */
	icon?: ComponentType<{ className?: string }>;
	/** Stable id: agent id, team id, space id, folder path, plugin id, … */
	id: string;
	kind: MentionKind;
	/** Display label — also the text inserted for entity mentions. */
	label: string;
	/** Present iff `kind === "plugin"` — the action selecting the row performs. */
	plugin?: ComposerPlugin;
}

/**
 * How selecting a composer plugin rewrites the draft. Both variants reuse
 * existing behaviour rather than inventing new backend semantics:
 *  - "slash" rewrites the composer to the plugin's real slash command (`/goal`,
 *    `/btw`), which the existing client interceptor / Core turn-hook then runs.
 *  - "prompt" replaces the fragment with a canned local instruction (a
 *    self-verify / proof request) — it works with no backend at all.
 */
export type ComposerPluginAction =
	| { type: "slash"; name: string }
	| { type: "prompt"; text: string };

/**
 * A composer plugin — the "anyone can build" extensibility unit. Built-ins ship
 * with Ryu; third-party plugins will register through the same list once the
 * plugin runtime lands (docs/rfc-plugin-runtime.md).
 */
export interface ComposerPlugin {
	action: ComposerPluginAction;
	/** True for Ryu's built-ins; false for future third-party plugins. */
	builtin: boolean;
	description: string;
	icon: ComponentType<{ className?: string }>;
	id: string;
	name: string;
}

/** The raw data the "@" menu draws its candidates from, per node. */
export interface MentionSources {
	agents: { id: string; name: string }[];
	/** Absolute project folder paths (the label is the basename). */
	folders: string[];
	mcp: { id: string; name: string }[];
	plugins: ComposerPlugin[];
	skills: { id: string; name: string }[];
	spaces: { id: string; name: string }[];
	teams: { id: string; name: string }[];
}

/** A labelled section of candidates in the menu (e.g. "Agents", "Plugins"). */
export interface MentionGroup {
	items: MentionItem[];
	kind: MentionKind;
	label: string;
}
