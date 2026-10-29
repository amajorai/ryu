import { z } from "zod";

/** Persisted identifiers outlive the current renderer's registered panel kinds. */
export const persistedDockTabKindSchema = z.string().min(1).max(512);
export type PersistedDockTabKind = z.infer<typeof persistedDockTabKindSchema>;

/** The serializable identity of one workspace dock tab. */
export interface WorkspaceSessionTab {
	kind: PersistedDockTabKind;
	label: string;
	/** Project tabs marked shared remain pinned if the dock store rebuilds them. */
	pinned?: boolean;
	/** Project-hosted tabs are restored through the project dock store. */
	project?: boolean;
	/** Runtime uid used to restore a tab's exact selection after a relaunch. */
	uid?: string;
}

export interface WorkspaceSessionDock {
	activeIndex: number;
	tabs: WorkspaceSessionTab[];
}

/** Workspace state attached to a chat's persisted desktop tab. */
export interface WorkspaceSessionState {
	bottom: WorkspaceSessionDock;
	bottomOpen: boolean;
	right: WorkspaceSessionDock;
	rightOpen: boolean;
}

export function emptyWorkspaceSessionState(): WorkspaceSessionState {
	return {
		bottom: { activeIndex: 0, tabs: [] },
		bottomOpen: false,
		right: { activeIndex: 0, tabs: [] },
		rightOpen: false,
	};
}

const workspaceSessionTabSchema = z
	.object({
		kind: persistedDockTabKindSchema,
		label: z.string(),
		project: z.literal(true).optional().catch(undefined),
		pinned: z.literal(true).optional().catch(undefined),
		uid: z.string().min(1).optional().catch(undefined),
	})
	.transform((row): WorkspaceSessionTab => {
		// Older builds saved worker-specific `subagent` tabs; restore the unified roster.
		const legacySubagent = row.kind === "subagent";
		const tab: WorkspaceSessionTab = {
			kind: legacySubagent ? "subagents" : row.kind,
			label: legacySubagent ? "Subagents" : row.label,
		};
		if (row.project) {
			tab.project = true;
		}
		if (row.pinned) {
			tab.pinned = true;
		}
		if (row.uid) {
			tab.uid = row.uid;
		}
		return tab;
	});
const workspaceSessionIndexSchema = z
	.union([
		z.number(),
		z.nan(),
		z.literal(Number.POSITIVE_INFINITY),
		z.literal(Number.NEGATIVE_INFINITY),
	])
	.catch(0);
const workspaceSessionDockSchema = z
	.object({
		activeIndex: workspaceSessionIndexSchema,
		tabs: z
			.array(workspaceSessionTabSchema.optional().catch(undefined))
			.catch([]),
	})
	.catch({ activeIndex: 0, tabs: [] })
	.transform((row): WorkspaceSessionDock => {
		const tabs = row.tabs.filter((tab) => tab !== undefined);
		return {
			tabs,
			activeIndex:
				tabs.length === 0
					? 0
					: Math.min(Math.max(0, Math.trunc(row.activeIndex)), tabs.length - 1),
		};
	});
export const workspaceSessionSchema = z.object({
	bottom: workspaceSessionDockSchema,
	bottomOpen: z.boolean().catch(false),
	right: workspaceSessionDockSchema,
	rightOpen: z.boolean().catch(false),
});
const workspaceSessionValueSchema = z.json().optional();
type WorkspaceSessionInput =
	| z.infer<typeof workspaceSessionValueSchema>
	| WorkspaceSessionState;

/** Normalize a persisted snapshot while retaining opaque historical/future kinds. */
export function parseWorkspaceSessionState(
	value: WorkspaceSessionInput
): WorkspaceSessionState | undefined {
	const parsed = workspaceSessionSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Compare snapshots without making React updates for an unchanged dock. */
function sameWorkspaceSessionDock(
	left: WorkspaceSessionDock | undefined,
	right: WorkspaceSessionDock | undefined
): boolean {
	if (!(left && right)) {
		return left === right;
	}
	if (
		left.activeIndex !== right.activeIndex ||
		left.tabs.length !== right.tabs.length
	) {
		return false;
	}
	return left.tabs.every((tab, index) => {
		const candidate = right.tabs[index];
		return (
			candidate !== undefined &&
			tab.kind === candidate.kind &&
			tab.label === candidate.label &&
			Boolean(tab.pinned) === Boolean(candidate.pinned) &&
			Boolean(tab.project) === Boolean(candidate.project) &&
			tab.uid === candidate.uid
		);
	});
}

export function sameWorkspaceSessionState(
	left: WorkspaceSessionState | undefined,
	right: WorkspaceSessionState | undefined
): boolean {
	if (!(left && right)) {
		return left === right;
	}
	return (
		sameWorkspaceSessionDock(left.bottom, right.bottom) &&
		left.bottomOpen === right.bottomOpen &&
		sameWorkspaceSessionDock(left.right, right.right) &&
		left.rightOpen === right.rightOpen
	);
}
