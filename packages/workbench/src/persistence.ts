import { z } from "zod";

import {
	createDefaultWorkbench,
	type DefaultWorkbenchIds,
	normalizeWorkbench,
	type WorkbenchItem,
	type WorkbenchItemSource,
	type WorkbenchRegion,
	type WorkbenchScope,
	type WorkbenchSplitNode,
	type WorkbenchState,
} from "./model.ts";

const MAX_GROUP_ID_LENGTH = 256;
const MAX_ITEM_ID_LENGTH = 512;
const MAX_SOURCE_STRING_LENGTH = 512;
const MAX_TITLE_LENGTH = 256;
const MAX_TREE_DEPTH = 32;

export interface WorkbenchIds extends DefaultWorkbenchIds {
	makeItemId: (sourceKey: string) => string;
}

/** Parsed legacy route row from the persisted desktop session. */
export interface LegacySessionTab {
	conversationId?: string;
	path: string;
	title: string;
}

interface ParsedLegacySessionTab {
	sourceIndex: number;
	tab: LegacySessionTab;
}

/** Parsed legacy dock tab from a chat workspace session. */
export interface LegacyWorkspaceDockTab {
	kind: string;
	label: string;
	pinned?: boolean;
	project?: boolean;
	uid?: string;
}

/** Parsed legacy dock, matching the persisted WorkspaceSessionState shape. */
export interface LegacyWorkspaceDock {
	activeIndex: number;
	tabs: LegacyWorkspaceDockTab[];
}

/** Parsed legacy workspace state attached to the active chat tab. */
export interface LegacyWorkspaceSessionState {
	bottom: LegacyWorkspaceDock;
	bottomOpen: boolean;
	right: LegacyWorkspaceDock;
	rightOpen: boolean;
}

/** Parsed legacy project-pinned dock row. */
export interface LegacyPinnedDockRow {
	kind: string;
	label: string;
	side: "bottom" | "right";
}

/** Values previously persisted across the desktop's independent layout stores. */
export interface LegacyWorkbenchInput {
	activeWorkspace?: unknown;
	folder?: string | null;
	pinnedByFolder?: unknown;
	session?: unknown;
	sidebarOpen?: boolean;
	sidebarWidth?: number;
	snapshot?: unknown;
}

export type PersistedWorkbenchSnapshot = Omit<WorkbenchState, "closedItems">;

const sourceTextSchema = z
	.string()
	.transform((value) => value.slice(0, MAX_SOURCE_STRING_LENGTH));
const titleSchema = z
	.string()
	.transform((value) => value.slice(0, MAX_TITLE_LENGTH));
const itemIdSchema = z
	.string()
	.transform((value) => value.slice(0, MAX_ITEM_ID_LENGTH));
const groupIdSchema = z
	.string()
	.transform((value) => value.slice(0, MAX_GROUP_ID_LENGTH));
const trueOnlySchema = z
	.unknown()
	.optional()
	.transform((value) => value === true);
const regionSchema = z.enum(["left", "center", "right", "bottom"]);
const bottomAlignmentSchema = z.enum(["center", "full", "left", "right"]);
const finiteNumberSchema = z.number().finite();
const optionalTextBoundarySchema = z.unknown().transform((value) => {
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data : undefined;
});
function clampString(
	value: z.input<typeof optionalTextBoundarySchema>,
	maximum: number
): string | undefined {
	return optionalTextBoundarySchema.parse(value)?.slice(0, maximum);
}
const scopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("window") }),
	z.object({ kind: z.literal("project"), folder: sourceTextSchema }),
	z.object({
		kind: z.literal("conversation"),
		conversationId: sourceTextSchema,
	}),
]);
const sourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("navigation") }),
	z.object({ kind: z.literal("route"), path: sourceTextSchema }),
	z.object({ kind: z.literal("shell"), panel: sourceTextSchema }),
	z.object({
		kind: z.literal("plugin"),
		panelId: sourceTextSchema,
		pluginId: sourceTextSchema,
	}),
]);
const itemSchema = z.object({
	closable: trueOnlySchema,
	duplicable: trueOnlySchema,
	id: itemIdSchema,
	pinned: trueOnlySchema,
	preferredRegion: regionSchema,
	scope: scopeSchema,
	source: sourceSchema,
	title: titleSchema,
});
const groupSchema = z.object({
	activeItemId: itemIdSchema
		.optional()
		.catch(undefined)
		.transform((value) => value ?? null),
	id: groupIdSchema,
	itemIds: z
		.array(itemIdSchema.optional().catch(undefined))
		.catch(() => [])
		.transform((values) => values.filter((value) => value !== undefined)),
	locked: trueOnlySchema,
	region: regionSchema,
});
// Validate one node at a time; untrusted descendants are only visited within the depth bound.
const treeEnvelopeSchema = z.unknown().pipe(
	z.discriminatedUnion("type", [
		z.object({ type: z.literal("leaf"), groupId: groupIdSchema }),
		z.object({
			type: z.literal("branch"),
			orientation: z.enum(["columns", "rows"]),
			children: z.array(z.unknown()).catch(() => []),
			sizes: z.array(finiteNumberSchema.catch(1)).catch(() => []),
		}),
	])
);
function parseTree(
	value: z.input<typeof treeEnvelopeSchema>,
	depth = 0
): WorkbenchSplitNode | undefined {
	if (depth > MAX_TREE_DEPTH) {
		return undefined;
	}
	const parsed = treeEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const node = parsed.data;
	if (node.type === "leaf") {
		return node;
	}
	const children = node.children.flatMap((child) => {
		const result = parseTree(child, depth + 1);
		return result ? [result] : [];
	});
	return children.length
		? {
				type: "branch",
				orientation: node.orientation,
				children,
				sizes: node.sizes,
			}
		: undefined;
}
const snapshotEnvelopeSchema = z.unknown().pipe(
	z.object({
		version: z.literal(2),
		groups: z.array(z.unknown()).optional().catch(undefined),
		items: z.array(z.unknown()).optional().catch(undefined),
		bottomAlignment: z.unknown().optional(),
		centerTree: z.unknown().optional(),
		focusedGroupId: z.unknown().optional(),
		openRegions: z.unknown().optional(),
		sizes: z.unknown().optional(),
	})
);
const snapshotRegionsSchema = z.object({
	bottom: trueOnlySchema,
	right: trueOnlySchema,
	left: z.boolean().optional().catch(undefined),
});
const snapshotSizesSchema = z.object({
	bottom: finiteNumberSchema.optional().catch(undefined),
	left: finiteNumberSchema.optional().catch(undefined),
	right: finiteNumberSchema.optional().catch(undefined),
});
/** Parse only the current, versioned persistence format, dropping invalid rows individually. */
export function parseWorkbenchSnapshot(
	value: z.input<typeof snapshotEnvelopeSchema>,
	ids: WorkbenchIds
): WorkbenchState | undefined {
	const parsed = snapshotEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const row = parsed.data;
	const fallback = createDefaultWorkbench(ids);
	const groups = row.groups
		? row.groups.flatMap((group) => {
				const result = groupSchema.safeParse(group);
				return result.success ? [result.data] : [];
			})
		: fallback.groups;
	const items = row.items
		? row.items.flatMap((item) => {
				const result = itemSchema.safeParse(item);
				return result.success ? [result.data] : [];
			})
		: fallback.items;
	const regions = snapshotRegionsSchema.safeParse(row.openRegions);
	const sizes = snapshotSizesSchema.safeParse(row.sizes);
	const alignment = bottomAlignmentSchema.safeParse(row.bottomAlignment);
	return normalizeWorkbench({
		bottomAlignment: alignment.success
			? alignment.data
			: fallback.bottomAlignment,
		centerTree: parseTree(row.centerTree) ?? fallback.centerTree,
		closedItems: [],
		focusedGroupId:
			clampString(row.focusedGroupId, MAX_GROUP_ID_LENGTH) ??
			fallback.focusedGroupId,
		groups,
		items,
		openRegions: {
			bottom: regions.success && regions.data.bottom,
			center: true,
			left: regions.success
				? (regions.data.left ?? fallback.openRegions.left)
				: fallback.openRegions.left,
			right: regions.success && regions.data.right,
		},
		sizes: {
			bottom: sizes.success
				? (sizes.data.bottom ?? fallback.sizes.bottom)
				: fallback.sizes.bottom,
			left: sizes.success
				? (sizes.data.left ?? fallback.sizes.left)
				: fallback.sizes.left,
			right: sizes.success
				? (sizes.data.right ?? fallback.sizes.right)
				: fallback.sizes.right,
		},
		version: 2,
	});
}

/** Serialize the stable persistence surface, excluding runtime close history. */
export function serializeWorkbenchSnapshot(
	state: WorkbenchState
): PersistedWorkbenchSnapshot {
	const normalized = normalizeWorkbench(state);
	const { closedItems: _closedItems, ...snapshot } = normalized;
	return snapshot;
}

/** Compare the serializable layout rather than runtime-only close history. */
export function sameWorkbenchSnapshot(
	left: WorkbenchState | undefined,
	right: WorkbenchState | undefined
): boolean {
	if (!(left && right)) {
		return left === right;
	}
	return (
		JSON.stringify(serializeWorkbenchSnapshot(left)) ===
		JSON.stringify(serializeWorkbenchSnapshot(right))
	);
}

const legacyTabSchema = z.object({
	path: sourceTextSchema,
	title: titleSchema,
	conversationId: sourceTextSchema.optional().catch(undefined),
});
const legacyEnvelopeSchema = z.unknown().pipe(
	z.object({
		tabs: z.array(z.unknown()).catch(() => []),
		activeIndex: finiteNumberSchema.catch(0),
	})
);
const legacyActiveSchema = z
	.unknown()
	.pipe(z.object({ activeIndex: finiteNumberSchema.catch(0) }));
function parseLegacySessionTabs(
	value: z.input<typeof legacyEnvelopeSchema>
): ParsedLegacySessionTab[] {
	const parsed = legacyEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		return [];
	}
	return parsed.data.tabs.flatMap((tab, sourceIndex) => {
		const result = legacyTabSchema.safeParse(tab);
		if (!result.success) {
			return [];
		}
		const { path, title, conversationId } = result.data;
		const resultTab: LegacySessionTab = { path, title };
		if (conversationId !== undefined) {
			resultTab.conversationId = conversationId;
		}
		return [{ sourceIndex, tab: resultTab }];
	});
}
function legacyActiveIndex(value: z.input<typeof legacyActiveSchema>): number {
	const parsed = legacyActiveSchema.safeParse(value);
	return parsed.success ? Math.max(0, Math.trunc(parsed.data.activeIndex)) : 0;
}
const legacyDockTabSchema = z.object({
	kind: sourceTextSchema,
	label: titleSchema,
	pinned: trueOnlySchema,
	project: trueOnlySchema,
	uid: sourceTextSchema.optional().catch(undefined),
});
function parseLegacyDock(
	value: z.input<typeof legacyEnvelopeSchema>
): LegacyWorkspaceDock {
	const parsed = legacyEnvelopeSchema.safeParse(value);
	const tabs = parsed.success
		? parsed.data.tabs.flatMap((tab) => {
				const result = legacyDockTabSchema.safeParse(tab);
				if (!result.success) {
					return [];
				}
				const { kind, label, pinned, project, uid } = result.data;
				const resultTab: LegacyWorkspaceDockTab = { kind, label };
				if (pinned) {
					resultTab.pinned = true;
				}
				if (project) {
					resultTab.project = true;
				}
				if (uid !== undefined) {
					resultTab.uid = uid;
				}
				return [resultTab];
			})
		: [];
	return { activeIndex: legacyActiveIndex(value), tabs };
}
const legacyWorkspaceSchema = z.unknown().pipe(
	z.object({
		bottom: z.unknown().optional(),
		right: z.unknown().optional(),
		bottomOpen: trueOnlySchema,
		rightOpen: trueOnlySchema,
	})
);
function parseLegacyWorkspace(
	value: z.input<typeof legacyWorkspaceSchema>
): LegacyWorkspaceSessionState {
	const parsed = legacyWorkspaceSchema.safeParse(value);
	return {
		bottom: parseLegacyDock(parsed.success ? parsed.data.bottom : undefined),
		bottomOpen: parsed.success && parsed.data.bottomOpen,
		right: parseLegacyDock(parsed.success ? parsed.data.right : undefined),
		rightOpen: parsed.success && parsed.data.rightOpen,
	};
}
const legacyPinnedRowSchema = z.object({
	kind: sourceTextSchema,
	label: titleSchema,
	side: z.enum(["bottom", "right"]),
});
const legacyPinnedByFolderSchema = z
	.unknown()
	.pipe(z.record(z.string(), z.unknown()));
function parseLegacyPinnedByFolder(
	value: z.input<typeof legacyPinnedByFolderSchema>
): Array<{ folder: string; row: LegacyPinnedDockRow }> {
	const parsed = legacyPinnedByFolderSchema.safeParse(value);
	if (!parsed.success) {
		return [];
	}
	return Object.entries(parsed.data).flatMap(([rawFolder, rows]) => {
		const list = z.array(z.unknown()).safeParse(rows);
		if (!list.success) {
			return [];
		}
		const folder = rawFolder.slice(0, MAX_SOURCE_STRING_LENGTH);
		return list.data.flatMap((row) => {
			const result = legacyPinnedRowSchema.safeParse(row);
			return result.success ? [{ folder, row: result.data }] : [];
		});
	});
}

function sourceIdentity(source: WorkbenchItemSource): string[] {
	switch (source.kind) {
		case "route":
			return ["route", source.path];
		case "shell":
			return ["shell", source.panel];
		case "plugin":
			return ["plugin", source.pluginId, source.panelId];
		case "navigation":
			return ["navigation"];
	}
}

function scopeIdentity(scope: WorkbenchScope): string[] {
	switch (scope.kind) {
		case "window":
			return ["window"];
		case "project":
			return ["project", scope.folder];
		case "conversation":
			return ["conversation", scope.conversationId];
	}
}

function semanticKey(
	source: WorkbenchItemSource,
	scope: WorkbenchScope
): string {
	return JSON.stringify([sourceIdentity(source), scopeIdentity(scope)]);
}

function uniqueGeneratedItemId(state: WorkbenchState, baseId: string): string {
	const usedIds = new Set(state.items.map((item) => item.id));
	const trimmedBaseId = baseId.slice(0, MAX_ITEM_ID_LENGTH);
	if (!usedIds.has(trimmedBaseId)) {
		return trimmedBaseId;
	}
	let suffix = 2;
	while (
		usedIds.has(`${trimmedBaseId.slice(0, MAX_ITEM_ID_LENGTH - 12)}-${suffix}`)
	) {
		suffix += 1;
	}
	return `${trimmedBaseId.slice(0, MAX_ITEM_ID_LENGTH - 12)}-${suffix}`;
}

function addMigratedItem(
	state: WorkbenchState,
	ids: WorkbenchIds,
	item: Omit<WorkbenchItem, "id">
): string {
	const key = semanticKey(item.source, item.scope);
	const existing = state.items.find(
		(candidate) => semanticKey(candidate.source, candidate.scope) === key
	);
	if (existing) {
		return existing.id;
	}
	const id = uniqueGeneratedItemId(state, ids.makeItemId(key));
	state.items.push({ ...item, id });
	const group = state.groups.find(
		(candidate) => candidate.region === item.preferredRegion
	);
	if (group) {
		group.itemIds.push(id);
	}
	return id;
}

function setLegacyActiveItem(
	state: WorkbenchState,
	region: WorkbenchRegion,
	itemIds: string[],
	activeIndex: number
): void {
	const activeItemId = itemIds[activeIndex];
	const group = state.groups.find((candidate) => candidate.region === region);
	if (activeItemId && group) {
		group.activeItemId = activeItemId;
		state.focusedGroupId = group.id;
	}
}

/**
 * Migrate the older independent desktop layout stores into one versioned
 * workbench snapshot. A valid v2 snapshot is returned unchanged semantically.
 */
export function migrateWorkbenchSnapshot(
	input: LegacyWorkbenchInput,
	ids: WorkbenchIds
): WorkbenchState {
	const snapshot = parseWorkbenchSnapshot(input.snapshot, ids);
	if (snapshot) {
		return snapshot;
	}

	const state = createDefaultWorkbench(ids);
	const folder = clampString(input.folder, MAX_SOURCE_STRING_LENGTH);
	const sessionTabs = parseLegacySessionTabs(input.session);
	const activeSessionPosition = sessionTabs.findIndex(
		({ sourceIndex }) => sourceIndex === legacyActiveIndex(input.session)
	);
	const activeConversationId =
		sessionTabs[activeSessionPosition]?.tab.conversationId;
	const sessionItemIds = sessionTabs.map((tab) =>
		addMigratedItem(state, ids, {
			closable: true,
			duplicable: true,
			pinned: false,
			preferredRegion: "center",
			scope: tab.tab.conversationId
				? {
						kind: "conversation",
						conversationId: tab.tab.conversationId,
					}
				: { kind: "window" },
			source: { kind: "route", path: tab.tab.path },
			title: tab.tab.title,
		})
	);
	setLegacyActiveItem(state, "center", sessionItemIds, activeSessionPosition);

	const workspace = parseLegacyWorkspace(input.activeWorkspace);
	for (const [region, dock] of [
		["bottom", workspace.bottom],
		["right", workspace.right],
	] as const) {
		const itemIds = dock.tabs.map((tab) =>
			addMigratedItem(state, ids, {
				closable: true,
				duplicable: true,
				pinned: tab.pinned === true,
				preferredRegion: region,
				scope:
					tab.project === true && folder !== undefined
						? { kind: "project", folder }
						: activeConversationId === undefined
							? { kind: "window" }
							: { kind: "conversation", conversationId: activeConversationId },
				source: { kind: "shell", panel: tab.kind },
				title: tab.label,
			})
		);
		setLegacyActiveItem(state, region, itemIds, dock.activeIndex);
	}

	for (const { folder: pinnedFolder, row } of parseLegacyPinnedByFolder(
		input.pinnedByFolder
	)) {
		addMigratedItem(state, ids, {
			closable: true,
			duplicable: true,
			pinned: true,
			preferredRegion: row.side,
			scope: { kind: "project", folder: pinnedFolder },
			source: { kind: "shell", panel: row.kind },
			title: row.label,
		});
	}

	state.openRegions = {
		bottom: workspace.bottomOpen,
		center: true,
		left: input.sidebarOpen !== false,
		right: workspace.rightOpen,
	};
	if (finiteNumberSchema.safeParse(input.sidebarWidth).success) {
		state.sizes.left = finiteNumberSchema.parse(input.sidebarWidth);
	}
	return normalizeWorkbench(state);
}
