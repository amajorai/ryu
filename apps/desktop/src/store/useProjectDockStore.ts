import { z } from "zod";
// apps/desktop/src/store/useProjectDockStore.ts
//
// Project-scoped workspace dock tabs. Shareable kinds (terminal, files,
// browser, …) live here keyed by folder so a pinned tab is the same live
// instance across every chat in that project. Unpinned entries stay owned by
// the window-tab that created them; pinning opts them into the shared strip.

import { create } from "zustand";
import type {
	DockSide,
	DockTabKind,
} from "@/src/components/panels/dock-panels.ts";
import type { PersistedDockTabKind } from "@/src/lib/workspace-session.ts";

const STORAGE_KEY = "ryu_pinned_dock_tabs";

export interface ProjectDockTab {
	/** Saved identifiers can outlive this build's registered renderers. */
	kind: PersistedDockTabKind;
	label: string;
	/** Window-tab id that owns this entry while unpinned. Ignored when pinned. */
	ownerTabId: string;
	pinned: boolean;
	side: DockSide;
	uid: string;
}

/** Only UI identity and pinned placement survive a reload; content mounts fresh. */
interface PersistedPinnedTab {
	kind: PersistedDockTabKind;
	label: string;
	side: DockSide;
	/** Missing on legacy rows; assigned and saved on their first valid restore. */
	uid?: string;
}

type PersistedByFolder = Record<string, PersistedPinnedTab[]>;

const persistedTab = z.object({
	kind: z.string().refine((kind) => kind.trim().length > 0),
	label: z.string(),
	side: z.enum(["bottom", "right"]),
	uid: z
		.string()
		.refine((uid) => uid.trim().length > 0)
		.optional()
		.catch(undefined),
});
const persistedFolders = z.record(
	z.string(),
	z.array(persistedTab.nullable().catch(null)).catch([])
);

function loadPersisted(): PersistedByFolder {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = persistedFolders.parse(JSON.parse(raw));
		const out: PersistedByFolder = Object.create(null);
		for (const [folder, tabs] of Object.entries(parsed)) {
			out[folder] = tabs.flatMap((tab) => (tab ? [tab] : []));
		}
		return out;
	} catch {
		return {};
	}
}

function persistPinned(byFolder: Record<string, ProjectDockTab[]>) {
	const out: PersistedByFolder = Object.create(null);
	for (const [folder, tabs] of Object.entries(byFolder)) {
		const pinned = tabs
			.filter((t) => t.pinned)
			.map((t) => ({ uid: t.uid, kind: t.kind, label: t.label, side: t.side }));
		if (pinned.length > 0) {
			out[folder] = pinned;
		}
	}
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
	} catch {
		// Best-effort; ignore quota / private-mode failures.
	}
}

let dockTabCounter = 0;
export function mintProjectDockUid(): string {
	dockTabCounter += 1;
	return `project-dock-${dockTabCounter}-${Date.now().toString(36)}`;
}

function isValidUid(uid: string | undefined): uid is string {
	return uid !== undefined && uid.trim().length > 0;
}

function mintUnusedProjectDockUid(usedUids: Set<string>): string {
	let uid = mintProjectDockUid();
	while (usedUids.has(uid)) {
		uid = mintProjectDockUid();
	}
	return uid;
}

/** Restore the local pinned UI projection, migrating legacy identities once. */
export function hydrateProjectDockTabs(): Record<string, ProjectDockTab[]> {
	const persisted = loadPersisted();
	const reservedUids = new Set(
		Object.values(persisted).flatMap((tabs) =>
			tabs.flatMap((tab) => (tab.uid ? [tab.uid] : []))
		)
	);
	const restoredUids = new Set<string>();
	const byFolder: Record<string, ProjectDockTab[]> = Object.create(null);
	let migrated = false;
	for (const [folder, tabs] of Object.entries(persisted)) {
		byFolder[folder] = tabs.map((tab) => {
			let uid = tab.uid;
			if (!uid || restoredUids.has(uid)) {
				uid = mintUnusedProjectDockUid(reservedUids);
				reservedUids.add(uid);
				migrated = true;
			}
			restoredUids.add(uid);
			return {
				uid,
				kind: tab.kind,
				label: tab.label,
				side: tab.side,
				pinned: true,
				// Restored pins have no owning chat — they are project-shared.
				ownerTabId: "",
			};
		});
	}
	// Do not replace wholly malformed storage with an empty projection on load.
	if (migrated) {
		persistPinned(byFolder);
	}
	return byFolder;
}

interface ProjectDockState {
	addTab: (
		folder: string,
		tab: Omit<ProjectDockTab, "uid" | "kind"> & {
			kind: DockTabKind;
			uid?: string;
		}
	) => ProjectDockTab;
	byFolder: Record<string, ProjectDockTab[]>;
	/** Drop unpinned tabs owned by a closed/unloaded window tab. */
	clearOwner: (folder: string, ownerTabId: string) => void;
	removeTab: (folder: string, uid: string) => void;
	setLabel: (folder: string, uid: string, label: string) => void;
	setSide: (folder: string, uid: string, side: DockSide) => void;
	togglePin: (folder: string, uid: string, fallbackOwnerTabId?: string) => void;
	updateTab: (
		folder: string,
		uid: string,
		patch: Partial<Pick<ProjectDockTab, "label" | "side" | "pinned">>
	) => void;
}

export const useProjectDockStore = create<ProjectDockState>((set, get) => ({
	byFolder: hydrateProjectDockTabs(),

	addTab: (folder, tab) => {
		const usedUids = new Set(
			Object.values(get().byFolder).flatMap((tabs) => tabs.map((t) => t.uid))
		);
		const entry: ProjectDockTab = {
			uid:
				isValidUid(tab.uid) && !usedUids.has(tab.uid)
					? tab.uid
					: mintUnusedProjectDockUid(usedUids),
			kind: tab.kind,
			label: tab.label,
			side: tab.side,
			pinned: tab.pinned,
			ownerTabId: tab.ownerTabId,
		};
		set((state) => {
			const prev = state.byFolder[folder] ?? [];
			const byFolder = {
				...state.byFolder,
				[folder]: [...prev, entry],
			};
			persistPinned(byFolder);
			return { byFolder };
		});
		return entry;
	},

	removeTab: (folder, uid) => {
		set((state) => {
			const prev = state.byFolder[folder] ?? [];
			const next = prev.filter((t) => t.uid !== uid);
			const byFolder = { ...state.byFolder };
			if (next.length === 0) {
				delete byFolder[folder];
			} else {
				byFolder[folder] = next;
			}
			persistPinned(byFolder);
			return { byFolder };
		});
	},

	togglePin: (folder, uid, fallbackOwnerTabId) => {
		set((state) => {
			const prev = state.byFolder[folder] ?? [];
			const byFolder = {
				...state.byFolder,
				[folder]: prev.map((t) =>
					t.uid === uid
						? {
								...t,
								pinned: !t.pinned,
								ownerTabId: t.ownerTabId || fallbackOwnerTabId || "",
							}
						: t
				),
			};
			persistPinned(byFolder);
			return { byFolder };
		});
	},

	setSide: (folder, uid, side) => {
		get().updateTab(folder, uid, { side });
	},

	setLabel: (folder, uid, label) => {
		get().updateTab(folder, uid, { label });
	},

	updateTab: (folder, uid, patch) => {
		set((state) => {
			const prev = state.byFolder[folder] ?? [];
			const byFolder = {
				...state.byFolder,
				[folder]: prev.map((t) => (t.uid === uid ? { ...t, ...patch } : t)),
			};
			persistPinned(byFolder);
			return { byFolder };
		});
	},

	clearOwner: (folder, ownerTabId) => {
		set((state) => {
			const prev = state.byFolder[folder] ?? [];
			const next = prev.filter((t) => t.pinned || t.ownerTabId !== ownerTabId);
			if (next.length === prev.length) {
				return state;
			}
			const byFolder = { ...state.byFolder };
			if (next.length === 0) {
				delete byFolder[folder];
			} else {
				byFolder[folder] = next;
			}
			persistPinned(byFolder);
			return { byFolder };
		});
	},
}));

/** Tabs visible in a given chat's dock strip for one side. */
export function visibleProjectDockTabs(
	tabs: ProjectDockTab[],
	side: DockSide,
	ownerTabId: string | undefined
): ProjectDockTab[] {
	return tabs.filter(
		(t) =>
			t.side === side &&
			(t.pinned || (ownerTabId != null && t.ownerTabId === ownerTabId))
	);
}
