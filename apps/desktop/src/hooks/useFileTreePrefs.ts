// apps/desktop/src/hooks/useFileTreePrefs.ts
//
// localStorage-backed preferences for the workspace "Files" tab file tree
// (`@pierre/trees` `FileTree`). Same shape/idiom as `useDiffViewPrefs`: one JSON
// blob under a single key, shared via an external store so the Appearance
// settings panel and the Files tab stay in sync the instant either changes a
// value (within and across windows).

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "ryu:file-tree-prefs";

// User-facing shape. Translated to `@pierre/trees` `FileTreeOptions` at the
// render site by `fileTreePrefsToOptions`.
export interface FileTreePrefs {
	/** Semantic per-file-type icon colors. */
	coloredIcons: boolean;
	/** Row height/spacing preset. */
	density: "compact" | "default" | "relaxed";
	/** Allow drag-and-drop reordering/moving. */
	dragAndDrop: boolean;
	/** Collapse a folder chain with a single child into one row. */
	flattenEmptyDirectories: boolean;
	/** Built-in file-icon set, or "none" for no icons. */
	iconSet: "minimal" | "standard" | "complete" | "none";
	/** Whether folders start expanded or collapsed. */
	initialExpansion: "closed" | "open";
	/** Allow inline rename (F2 / double-click). */
	renaming: boolean;
	/** How a search query reshapes the tree. */
	searchMode: "expand-matches" | "collapse-non-matches" | "hide-non-matches";
	/** Show the filter/search box above the tree. */
	showSearch: boolean;
	/** Keep parent folders pinned to the top while scrolling their children. */
	stickyFolders: boolean;
}

export const DEFAULT_FILE_TREE_PREFS: FileTreePrefs = {
	density: "default",
	iconSet: "standard",
	coloredIcons: true,
	stickyFolders: true,
	showSearch: false,
	searchMode: "expand-matches",
	dragAndDrop: false,
	renaming: false,
	flattenEmptyDirectories: false,
	initialExpansion: "closed",
};

const listeners = new Set<() => void>();
let cache: FileTreePrefs = DEFAULT_FILE_TREE_PREFS;
let cacheRaw: string | null = null;

function read(): FileTreePrefs {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === cacheRaw) {
			return cache;
		}
		cacheRaw = raw;
		cache = raw
			? {
					...DEFAULT_FILE_TREE_PREFS,
					...(JSON.parse(raw) as Partial<FileTreePrefs>),
				}
			: DEFAULT_FILE_TREE_PREFS;
	} catch {
		cache = DEFAULT_FILE_TREE_PREFS;
	}
	return cache;
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

function write(next: FileTreePrefs) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Persistence is best-effort.
	}
	cacheRaw = null;
	for (const cb of listeners) {
		cb();
	}
}

/**
 * Translate the plain-English prefs into `@pierre/trees` `FileTreeOptions`. One
 * mapping, shared by the Files tab and the settings live preview.
 */
export function fileTreePrefsToOptions(prefs: FileTreePrefs) {
	return {
		density: prefs.density,
		icons: { set: prefs.iconSet, colored: prefs.coloredIcons },
		stickyFolders: prefs.stickyFolders,
		search: prefs.showSearch,
		fileTreeSearchMode: prefs.searchMode,
		dragAndDrop: prefs.dragAndDrop,
		renaming: prefs.renaming,
		flattenEmptyDirectories: prefs.flattenEmptyDirectories,
		initialExpansion: prefs.initialExpansion,
	};
}

/** Merge a partial patch into the stored file-tree prefs. */
export function setFileTreePrefs(patch: Partial<FileTreePrefs>) {
	write({ ...read(), ...patch });
}

/** Restore every file-tree pref to its default. */
export function resetFileTreePrefs() {
	write(DEFAULT_FILE_TREE_PREFS);
}

/** Current file-tree prefs, re-rendering the caller whenever they change. */
export function useFileTreePrefs(): FileTreePrefs {
	return useSyncExternalStore(
		useCallback((cb: () => void) => subscribe(cb), []),
		read,
		() => DEFAULT_FILE_TREE_PREFS
	);
}
