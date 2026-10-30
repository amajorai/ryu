// Builds the grouped, filtered candidate list for the composer "@" menu, and
// applies a chosen mention back into the composer text. Pure functions — the
// menu component owns keyboard/dismiss state, ChatPage owns the data sources.
// See docs/rfc-mention-composer.md.

import {
	BubbleChatIcon,
	DashboardSquare01Icon,
	Database01Icon,
	File01Icon,
	Folder01Icon,
	GitBranchIcon,
	Plug01Icon,
	RoboticIcon,
	SparklesIcon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { hugeiconComponent } from "@ryu/blocks/desktop/agent-elements/icons/hugeicon-component.tsx";
import type {
	MentionGroup,
	MentionItem,
	MentionKind,
	MentionSources,
} from "./types.ts";

const IconApps = hugeiconComponent(DashboardSquare01Icon);
const IconDatabase = hugeiconComponent(Database01Icon);
const IconFileText = hugeiconComponent(File01Icon);
const IconFolder = hugeiconComponent(Folder01Icon);
const IconGitBranch = hugeiconComponent(GitBranchIcon);
const IconMessages = hugeiconComponent(BubbleChatIcon);
const IconPlug = hugeiconComponent(Plug01Icon);
const IconRobot = hugeiconComponent(RoboticIcon);
const IconSparkles = hugeiconComponent(SparklesIcon);
const IconUsers = hugeiconComponent(UserGroupIcon);

export const CHAT_MENTION_KINDS = [
	"agent",
	"app",
	"plugin",
	"workflow",
	"user",
] as const;

const PATH_SEPARATOR = /[\\/]/;
/** The in-progress "@word" fragment at the cursor (after start or whitespace). */
const TRAILING_MENTION = /(?<=(?:^|\s))@\w*$/;
const MENTION_BOUNDARY = /[\s<>()[\]{}"'.,;:!?]/;
/** Last path segment of a folder path (the folder's display name). */
function basename(path: string): string {
	const parts = path.split(PATH_SEPARATOR).filter(Boolean);
	return parts.at(-1) ?? path;
}

export interface ComposioMentionConnection {
	active: boolean;
	toolkit: string;
}

export interface ComposioMentionToolkit {
	description: string | null;
	name: string;
	slug: string;
}

function humanizeToolkitSlug(slug: string): string {
	return slug
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Convert active Composio connections into mention sources.
 *
 * `configured` is Core's redacted setup signal: it is true when the active node
 * has a usable BYOK credential or a provisioned managed/proxy credential. Keep
 * this gate here as well as on the query so stale cached connections can never
 * reappear after setup is removed or the user changes nodes.
 */
export function buildComposioMentionSources(
	configured: boolean,
	connections: readonly ComposioMentionConnection[],
	toolkits: readonly ComposioMentionToolkit[]
): MentionSources["integrations"] {
	if (!configured) {
		return [];
	}

	const toolkitBySlug = new Map(
		toolkits
			.filter((toolkit) => toolkit.slug.trim().length > 0)
			.map((toolkit) => [toolkit.slug.trim().toLowerCase(), toolkit])
	);
	const seen = new Set<string>();
	const result: MentionSources["integrations"] = [];

	for (const connection of connections) {
		if (!connection.active) {
			continue;
		}
		const slug = connection.toolkit.trim();
		const key = slug.toLowerCase();
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);

		const toolkit = toolkitBySlug.get(key);
		result.push({
			description: toolkit?.description?.trim() || "Connected through Composio",
			id: toolkit?.slug ?? slug,
			name: toolkit?.name?.trim() || humanizeToolkitSlug(slug),
		});
	}

	return result;
}

/** Resolve the first exact named @mention, including labels containing spaces. */
export function resolveFirstNamedMentionId(
	text: string,
	candidates: readonly { id: string; name: string }[]
): string | null {
	const lowerText = text.toLowerCase();
	const ordered = [...candidates]
		.filter((candidate) => candidate.name.trim().length > 0)
		.sort((left, right) => right.name.length - left.name.length);

	for (const candidate of ordered) {
		const token = `@${candidate.name.trim().toLowerCase()}`;
		let fromIndex = 0;
		while (fromIndex < lowerText.length) {
			const index = lowerText.indexOf(token, fromIndex);
			if (index < 0) {
				break;
			}
			const previous = lowerText[index - 1];
			const next = lowerText[index + token.length];
			if (
				(index === 0 || /\s/.test(previous ?? "")) &&
				(next === undefined || MENTION_BOUNDARY.test(next))
			) {
				return candidate.id;
			}
			fromIndex = index + token.length;
		}
	}

	return null;
}

/**
 * Group the mention sources into labelled sections, filtered by `query`
 * (case-insensitive substring). Order puts the two
 * targeting mentions (agents, teams) first, then plugins, then context refs.
 */
export function buildMentionGroups(
	sources: MentionSources,
	query: string,
	allowedKinds?: readonly MentionKind[]
): MentionGroup[] {
	const allowed = new Set(allowedKinds);
	const q = query.trim().toLowerCase();
	const matches = (...fields: string[]) =>
		q === "" || fields.some((f) => f.toLowerCase().includes(q));
	const groups: MentionGroup[] = [];

	const add = (
		kind: MentionGroup["kind"],
		label: string,
		items: MentionItem[]
	) => {
		if (items.length > 0 && (!allowedKinds || allowed.has(kind))) {
			groups.push({ kind, label, items });
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
		"Groups",
		sources.teams
			.filter((t) => matches(t.name))
			.map((t) => ({ kind: "team", id: t.id, label: t.name, icon: IconUsers }))
	);
	add(
		"workflow",
		"Workflows",
		sources.workflows
			.filter((w) => matches(w.name))
			.map((w) => ({
				kind: "workflow",
				id: w.id,
				label: w.name,
				description: w.description ?? undefined,
				icon: IconGitBranch,
			}))
	);
	add(
		"chat",
		"Chats",
		sources.chats
			.filter((chat) => matches(chat.name, chat.description ?? ""))
			.map((chat) => ({
				kind: "chat",
				id: chat.id,
				label: chat.name,
				description: chat.description,
				icon: IconMessages,
			}))
	);
	add(
		"app",
		"Apps",
		(sources.apps ?? [])
			.filter((app) => matches(app.name, app.id, app.description ?? ""))
			.map((app) => ({
				accentColor: app.accentColor,
				kind: "app",
				id: app.id,
				label: app.name,
				description: app.description,
				icon: IconApps,
				visualIcon: app.visualIcon,
			}))
	);
	add(
		"app-item",
		"App items",
		(sources.appItems ?? [])
			.filter((item) => matches(item.name, item.id, item.description ?? ""))
			.map((item) => {
				const owner: Pick<MentionItem, "ownerId"> = {};
				if (item.ownerId) {
					owner.ownerId = item.ownerId;
				}
				return {
					accentColor: item.accentColor,
					kind: "app-item",
					resourceUri: item.resourceUri,
					id: item.id,
					label: item.name,
					...owner,
					description: item.description,
					target: item.target,
					icon: IconApps,
					visualIcon: item.visualIcon,
				} satisfies MentionItem;
			})
	);
	add(
		"integration",
		"Integrations",
		sources.integrations
			.filter((integration) =>
				matches(integration.name, integration.id, integration.description ?? "")
			)
			.map((integration) => ({
				kind: "integration",
				id: integration.id,
				label: integration.name,
				description: integration.description,
				icon: IconPlug,
			}))
	);
	add(
		"plugin",
		"Plugins",
		sources.plugins
			.filter((p) => matches(p.name, p.id, p.description ?? ""))
			.map((p) => ({
				accentColor: p.accentColor,
				kind: "plugin",
				id: p.id,
				label: p.name,
				description: p.description,
				icon: IconPlug,
				visualIcon: p.visualIcon,
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
		"page",
		"Space pages",
		(sources.pages ?? [])
			.filter((page) => matches(page.name, page.id, page.description ?? ""))
			.map((page) => ({
				accentColor: page.accentColor,
				kind: "page",
				id: page.id,
				label: page.name,
				description: page.description,
				target: page.target,
				icon: IconFileText,
				visualIcon: page.visualIcon,
			}))
	);
	add(
		"output-style",
		"Personality profiles",
		(sources.outputStyles ?? [])
			.filter((style) => matches(style.name, style.id, style.description ?? ""))
			.map((style) => ({
				accentColor: style.accentColor,
				kind: "output-style",
				id: style.id,
				label: style.name,
				description: style.description,
				target: style.target,
				icon: IconSparkles,
				visualIcon: style.visualIcon,
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
	add(
		"user",
		"Users",
		(sources.users ?? [])
			.filter((user) => matches(user.name, user.id, user.description ?? ""))
			.map((user) => ({
				description: user.description,
				id: user.id,
				kind: "user",
				label: user.name,
				visualIcon: user.visualIcon,
			}))
	);

	if (!allowedKinds) {
		return groups;
	}
	const order = new Map(allowedKinds.map((kind, index) => [kind, index]));
	return groups.sort(
		(left, right) =>
			(order.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
			(order.get(right.kind) ?? Number.MAX_SAFE_INTEGER)
	);
}

/**
 * Apply a chosen mention back into the composer value by replacing the trailing
 * "@fragment" with an "@Label " token.
 */
export function applyMention(value: string, item: MentionItem): string {
	return value.replace(TRAILING_MENTION, `@${item.label} `);
}

/** Resolve chat tokens at send time so deleting a mention also removes its
 * context attachment. `selectedIds` disambiguates duplicate conversation titles;
 * manually typed exact titles still work when no menu/drop selection exists. */
export function resolveReferencedChatIds(
	content: string,
	chats: MentionSources["chats"],
	selectedIds: ReadonlySet<string>
): string[] {
	const mentioned = chats.filter((chat) => content.includes(`@${chat.name}`));
	const selected = mentioned.filter((chat) => selectedIds.has(chat.id));
	return (selected.length > 0 ? selected : mentioned).map((chat) => chat.id);
}
