// The sidebar's focusable rows as one flat list. Mouse rendering and keyboard
// focus mode both read it, so a row that can be clicked is exactly a row that
// ↑/↓ can reach, in the same order. Pure: no React, no I/O.

import type { ProductMode } from "../core/productMode.ts";
import type { SidebarData, SidebarItem } from "./data.ts";

/** Total sidebar columns, including its one-column side padding. */
export const SIDEBAR_WIDTH = 24;
/** Columns available to a row's content (SIDEBAR_WIDTH minus the padding). */
export const SIDEBAR_CONTENT_WIDTH = SIDEBAR_WIDTH - 2;
/** Items shown per section; the rest stay one palette search away. */
export const SECTION_ITEM_LIMIT = 8;
/** Chats shown under each project group. */
export const PROJECT_CHAT_LIMIT = 5;

const ELLIPSIS = "…";

/** The collapsible live-data sections in desktop order. */
export type SectionKey =
	| "agents"
	| "teams"
	| "spaces"
	| "meetings"
	| "workflows"
	| "pinned"
	| "projects"
	| "chats"
	| "archived";

export interface SectionSpec {
	createPath: string;
	key: Exclude<SectionKey, "projects">;
	title: string;
}

/** Sections before the projects group, then the ones after it. */
export const LEADING_SECTIONS: readonly SectionSpec[] = [
	{ key: "agents", title: "Agents", createPath: "/agents" },
	{ key: "teams", title: "Groups", createPath: "/teams" },
	{ key: "spaces", title: "Spaces", createPath: "/spaces" },
	{ key: "meetings", title: "Meetings", createPath: "/meetings" },
	{ key: "workflows", title: "Workflows", createPath: "/workflows" },
	{ key: "pinned", title: "Pinned", createPath: "/chat" },
];
export const TRAILING_SECTIONS: readonly SectionSpec[] = [
	{ key: "chats", title: "Chats", createPath: "/chat" },
	{ key: "archived", title: "Archived", createPath: "/chat" },
];

/** One focusable sidebar row. */
export interface SidebarRow {
	/** True for a section header: Enter folds it instead of leaving the sidebar. */
	header?: boolean;
	/** Stable across data reloads; also the rendered row's id suffix. */
	key: string;
	label: string;
	onSelect: () => void;
	/** The section a header or item belongs to (for ←/→ fold and unfold). */
	section?: SectionKey;
}

export interface SidebarRowActions {
	openPalette: () => void;
	openSettings: () => void;
	openTab: (path: string, options?: { forceNew?: boolean }) => void;
	switchMode: () => void;
	switchNode: () => void;
	toggleSection: (section: SectionKey) => void;
}

export type CollapsedSections = Readonly<Partial<Record<SectionKey, boolean>>>;

/** The renderer id of a row, so the scrollbox can bring it into view. */
export function sidebarRowId(key: string): string {
	return `sidebar-row:${key}`;
}

/** Number of entries a section shows a count for. */
export function sectionCount(data: SidebarData, section: SectionKey): number {
	return data[section].length;
}

/**
 * Resolve each section's collapsed state. Until the user folds one, a section
 * follows its data: empty sections collapse to their header and expand once
 * items arrive (data loads asynchronously, so the default stays derived).
 */
export function resolveCollapsed(
	data: SidebarData,
	overrides: CollapsedSections
): Record<SectionKey, boolean> {
	const keys: SectionKey[] = [
		...LEADING_SECTIONS.map((section) => section.key),
		"projects",
		...TRAILING_SECTIONS.map((section) => section.key),
	];
	const collapsed = {} as Record<SectionKey, boolean>;
	for (const key of keys) {
		collapsed[key] = overrides[key] ?? sectionCount(data, key) === 0;
	}
	return collapsed;
}

/** The sidebar's primary destinations, shared by the mouse cluster and keys. */
export function navEntries(
	actions: Pick<SidebarRowActions, "openPalette" | "openTab">
): (SidebarRow & { path?: string })[] {
	return [
		{
			key: "nav:home",
			label: "Home",
			path: "/home",
			onSelect: () => actions.openTab("/home"),
		},
		{
			key: "nav:new-chat",
			label: "New chat",
			path: "/chat",
			onSelect: () => actions.openTab("/chat", { forceNew: true }),
		},
		{
			key: "nav:search",
			label: "Search (Ctrl+K)",
			onSelect: actions.openPalette,
		},
		{
			key: "nav:library",
			label: "Library",
			path: "/library",
			onSelect: () => actions.openTab("/library"),
		},
		{
			key: "nav:store",
			label: "Customize",
			path: "/store",
			onSelect: () => actions.openTab("/store"),
		},
		{
			key: "nav:tasks",
			label: "Tasks",
			path: "/tasks",
			onSelect: () => actions.openTab("/tasks"),
		},
		{
			key: "nav:timeline",
			label: "Timeline",
			path: "/timeline",
			onSelect: () => actions.openTab("/timeline"),
		},
	];
}

function sectionRows(
	section: SectionSpec,
	items: readonly SidebarItem[],
	collapsed: boolean,
	actions: SidebarRowActions
): SidebarRow[] {
	const rows: SidebarRow[] = [
		{
			header: true,
			key: `section:${section.key}`,
			label: section.title.toUpperCase(),
			onSelect: () => actions.toggleSection(section.key),
			section: section.key,
		},
	];
	if (collapsed) {
		return rows;
	}
	for (const item of items.slice(0, SECTION_ITEM_LIMIT)) {
		rows.push({
			key: `item:${section.key}:${item.id}`,
			label: item.label,
			onSelect: () => actions.openTab(item.path),
			section: section.key,
		});
	}
	return rows;
}

/**
 * Flatten the sidebar into its focusable rows, top to bottom: node and mode
 * selectors, the nav cluster, each section header and its visible items, and
 * the account footer. Bot mode keeps only its reduced cluster.
 */
export function buildSidebarRows(
	data: SidebarData,
	collapsed: Readonly<Record<SectionKey, boolean>>,
	mode: ProductMode,
	actions: SidebarRowActions
): SidebarRow[] {
	const modeRow: SidebarRow = {
		key: "mode",
		label: "Mode",
		onSelect: actions.switchMode,
	};
	const settingsRow: SidebarRow = {
		key: "footer:account",
		label: "Account",
		onSelect: actions.openSettings,
	};
	if (mode === "bot") {
		const nav = navEntries(actions);
		return [
			modeRow,
			...nav.filter(
				(entry) => entry.key === "nav:new-chat" || entry.key === "nav:search"
			),
			{ ...settingsRow, label: "Account & Settings" },
		];
	}
	const rows: SidebarRow[] = [
		{ key: "node", label: "Node", onSelect: actions.switchNode },
		modeRow,
		...navEntries(actions),
	];
	for (const section of LEADING_SECTIONS) {
		rows.push(
			...sectionRows(
				section,
				data[section.key],
				collapsed[section.key],
				actions
			)
		);
	}
	rows.push({
		header: true,
		key: "section:projects",
		label: "PROJECTS",
		onSelect: () => actions.toggleSection("projects"),
		section: "projects",
	});
	if (!collapsed.projects) {
		for (const project of data.projects) {
			for (const chat of project.chats.slice(0, PROJECT_CHAT_LIMIT)) {
				rows.push({
					key: `item:projects:${project.id}:${chat.id}`,
					label: chat.label,
					onSelect: () => actions.openTab(chat.path),
					section: "projects",
				});
			}
		}
	}
	for (const section of TRAILING_SECTIONS) {
		rows.push(
			...sectionRows(
				section,
				data[section.key],
				collapsed[section.key],
				actions
			)
		);
	}
	rows.push(
		settingsRow,
		{
			key: "footer:inbox",
			label: "Inbox",
			onSelect: () => actions.openTab("/inbox"),
		},
		{
			key: "footer:downloads",
			label: "Downloads",
			onSelect: () => actions.openTab("/downloads"),
		}
	);
	return rows;
}

/** Terminal columns a string occupies (wide CJK/emoji count as two). */
export function displayWidth(text: string): number {
	return Bun.stringWidth(text);
}

/** Fit `text` into `max` columns, ending with "…" when it is cut. */
export function truncateLabel(text: string, max: number): string {
	if (displayWidth(text) <= max) {
		return text;
	}
	if (max <= 0) {
		return "";
	}
	let out = "";
	let width = 0;
	for (const character of text) {
		const next = displayWidth(character);
		if (width + next > max - 1) {
			break;
		}
		out += character;
		width += next;
	}
	return `${out.trimEnd()}${ELLIPSIS}`;
}

/** Fit `text` into `max` columns by dropping its start ("…0.0.1:7980"), so the
 * distinguishing tail (a URL's port) stays visible. */
export function truncateStart(text: string, max: number): string {
	if (displayWidth(text) <= max) {
		return text;
	}
	if (max <= 0) {
		return "";
	}
	const characters = [...text];
	let out = "";
	let width = 0;
	for (let index = characters.length - 1; index >= 0; index -= 1) {
		const character = characters[index] ?? "";
		const next = displayWidth(character);
		if (width + next > max - 1) {
			break;
		}
		out = character + out;
		width += next;
	}
	return `${ELLIPSIS}${out}`;
}
