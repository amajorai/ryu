// The typed model behind the composer's "@" mention system. A Mention is a typed
// reference the user drops into the chat composer — an agent, app, human,
// team, space, skill, MCP server, project folder, connected integration, or
// installed plugin.

import type { ComponentType, ReactNode } from "react";

export type MentionKind =
	| "agent"
	| "app"
	| "app-item"
	| "chat"
	| "team"
	| "workflow"
	| "space"
	| "page"
	| "output-style"
	| "skill"
	| "mcp"
	| "folder"
	| "integration"
	| "plugin"
	| "user";

/** A safe in-app destination carried by a resolved mention. */
export interface MentionTarget {
	options?: { conversationId?: string };
	path: string;
}

/** A source row that can optionally open a concrete host destination. */
export interface MentionSourceItem {
	accentColor?: string;
	/** Safe remote avatar URL for consumers that need a larger visual than the
	 * compact mention token. */
	avatarUrl?: string;
	description?: string;
	id: string;
	name: string;
	ownerId?: string;
	resourceUri?: string;
	target?: MentionTarget;
	visualIcon?: ReactNode;
}

/** A single, resolved mention candidate shown in the "@" menu. */
export interface MentionItem {
	accentColor?: string;
	/** Optional secondary line (e.g. a skill description or folder path). */
	description?: string;
	/** Icon for the row. */
	icon?: ComponentType<{ className?: string }>;
	/** Stable id: agent id, team id, space id, folder path, plugin id, … */
	id: string;
	kind: MentionKind;
	/** Display label — also the text inserted for entity mentions. */
	label: string;
	/** Owning app or plugin for app-contributed rows. */
	ownerId?: string;
	resourceUri?: string;
	/** Host route for app rows, Space pages, and other navigable resources. */
	target?: MentionTarget;
	/** App-owned artwork, kept as a node so hosts can reuse their canonical icon. */
	visualIcon?: ReactNode;
}

/** The raw data the "@" menu draws its candidates from, per node. */
export interface MentionSources {
	agents: { id: string; name: string }[];
	/** Rows from the same app sidebar-section sources used by Library. */
	appItems: MentionSourceItem[];
	/** Enabled desktop apps, discovered from Core's manifest registry. */
	apps: MentionSourceItem[];
	/** Saved conversations available as read-only context for the next turn. */
	chats: { id: string; name: string; description?: string }[];
	/** Absolute project folder paths (the label is the basename). */
	folders: string[];
	/** Connected integrations, such as active Composio toolkits. */
	integrations: { id: string; name: string; description?: string }[];
	mcp: { id: string; name: string }[];
	/** Personality profiles available to assign from the Agents page. */
	outputStyles: MentionSourceItem[];
	/** Documents listed inside Spaces, including pages, databases, and boards. */
	pages: MentionSourceItem[];
	/** Enabled non-app plugins, discovered from the same manifest registry. */
	plugins: MentionSourceItem[];
	skills: { id: string; name: string }[];
	spaces: { id: string; name: string }[];
	teams: { id: string; name: string }[];
	/** Human members resolved by the Inbox app's node-scoped directory. */
	users: MentionSourceItem[];
	/** Chat-triggerable workflows (those with a root `Input` node, per Core). */
	workflows: { id: string; name: string; description?: string | null }[];
}

/** A labelled section of candidates in the menu (e.g. "Agents", "Plugins"). */
export interface MentionGroup {
	items: MentionItem[];
	kind: MentionKind;
	label: string;
}
