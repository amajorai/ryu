import { stat } from "@tauri-apps/plugin-fs";
import { create } from "zustand";
import { isLocalNode, useNodeStore } from "./useNodeStore.ts";

const STORAGE_KEY = "ryu_workspace_folder";
const RECENTS_KEY = "ryu_workspace_recents";
const REMOVED_KEY = "ryu_workspace_removed";
const WORKTREE_MODE_KEY = "ryu_workspace_worktree_mode";
const WORKTREE_BRANCH_KEY = "ryu_workspace_worktree_branch";
const TERMINAL_SHELL_KEY = "ryu_workspace_terminal_shell";
const ICONS_KEY = "ryu_workspace_icons";
const MAX_RECENTS = 10;

/**
 * A per-project custom glyph, keyed by folder path. Either a single emoji or an
 * uploaded image stored inline as a (small, downscaled) data URL — both are
 * purely presentational desktop-local state, so they live here in localStorage
 * alongside the other workspace preferences rather than in Core.
 */
export type ProjectIcon =
	| { type: "emoji"; value: string }
	| { type: "image"; value: string };

interface WorkspaceState {
	/**
	 * Register a folder as a project WITHOUT making it the active folder or
	 * touching disk. Adds it to `recentFolders` (so it shows in the sidebar's
	 * Projects section even before it has chats) and un-hides it if it was
	 * previously removed. Used by auto-import to surface the folders imported
	 * threads ran in — unlike `setFolder`, it neither `stat`s the path (the cwd
	 * may not exist on this machine) nor changes what a new chat runs against.
	 */
	addProjectFolder: (path: string) => void;
	clearFolder: () => void;
	/** Remove any custom icon for a project, reverting it to the folder glyph. */
	clearProjectIcon: (path: string) => void;
	folder: string | null;
	/** Custom per-project glyphs (emoji or uploaded image), keyed by folder path. */
	projectIcons: Record<string, ProjectIcon>;
	recentFolders: string[];
	/** Replace the suggested branch name with a freshly generated friendly one. */
	regenerateWorktreeBranch: () => void;
	/**
	 * Paths the user has explicitly removed from the app's project list. The
	 * sidebar's project list is the union of `recentFolders` and the folders of
	 * existing conversations (durable Core data), so a folder that still has
	 * chats would otherwise reappear after dropping it from recents. Remembering
	 * removals keeps "Remove from app" sticky; (re)importing the folder un-hides
	 * it. Synced across the sidebar and the composer's project picker.
	 */
	removedProjects: string[];
	/**
	 * Remove a project from the app everywhere: drop it from recents and remember
	 * it as removed so its conversations don't resurrect it in the sidebar.
	 */
	removeProject: (path: string) => void;
	/** Drop a recent without marking it removed (e.g. a stale/missing path). */
	removeRecentFolder: (path: string) => void;
	setFolder: (path: string) => Promise<void>;
	/** Assign a custom glyph (emoji or uploaded image) to a project folder. */
	setProjectIcon: (path: string, icon: ProjectIcon) => void;
	/**
	 * Choose which shell the built-in terminal and git actions run through.
	 * The value is either `"auto"` (the OS default) or one of the allowlisted
	 * shell names understood by the Rust `shell_execute` command.
	 */
	setTerminalShell: (shell: string) => void;
	setWorktreeBranch: (name: string) => void;
	setWorktreeMode: (on: boolean) => void;
	/**
	 * The shell the built-in terminal and git actions run through: `"auto"` for
	 * the OS default, or an allowlisted shell name (bash/zsh/sh/fish/powershell/
	 * pwsh/cmd). Desktop-local preference, persisted in localStorage.
	 */
	terminalShell: string;
	/** Desired branch name for the *next* new worktree (editable, friendly). */
	worktreeBranch: string;
	/**
	 * When true, a folder-rooted ACP run executes inside a persistent, isolated
	 * git worktree for the conversation (created on the first message, reused on
	 * later turns) instead of mutating the selected folder directly.
	 */
	worktreeMode: boolean;
}

function loadRecents(): string[] {
	try {
		const raw = localStorage.getItem(RECENTS_KEY);
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveRecents(recents: string[]) {
	localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
}

function loadRemoved(): string[] {
	try {
		const raw = localStorage.getItem(REMOVED_KEY);
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveRemoved(removed: string[]) {
	localStorage.setItem(REMOVED_KEY, JSON.stringify(removed));
}

function loadIcons(): Record<string, ProjectIcon> {
	try {
		const raw = localStorage.getItem(ICONS_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function saveIcons(icons: Record<string, ProjectIcon>) {
	localStorage.setItem(ICONS_KEY, JSON.stringify(icons));
}

// Conductor-style memorable, collision-resistant names so parallel worktrees
// are scannable at a glance (e.g. `ryu/swift-otter`) instead of opaque uuids.
const NAME_ADJECTIVES = [
	"swift",
	"brave",
	"calm",
	"bright",
	"lucky",
	"bold",
	"quiet",
	"eager",
	"nimble",
	"sunny",
	"amber",
	"cosmic",
	"crisp",
	"merry",
	"royal",
] as const;
const NAME_NOUNS = [
	"otter",
	"falcon",
	"maple",
	"comet",
	"harbor",
	"willow",
	"pixel",
	"ember",
	"cedar",
	"koi",
	"lark",
	"mesa",
	"reef",
	"finch",
	"opal",
] as const;

export function suggestWorktreeBranch(): string {
	const adj =
		NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
	const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
	return `ryu/${adj}-${noun}`;
}

function loadWorktreeBranch(): string {
	const saved = localStorage.getItem(WORKTREE_BRANCH_KEY);
	if (saved?.trim()) {
		return saved;
	}
	const fresh = suggestWorktreeBranch();
	localStorage.setItem(WORKTREE_BRANCH_KEY, fresh);
	return fresh;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
	folder: localStorage.getItem(STORAGE_KEY) ?? null,
	projectIcons: loadIcons(),
	recentFolders: loadRecents(),
	removedProjects: loadRemoved(),
	terminalShell: localStorage.getItem(TERMINAL_SHELL_KEY) ?? "auto",
	worktreeMode: localStorage.getItem(WORKTREE_MODE_KEY) === "true",
	worktreeBranch: loadWorktreeBranch(),

	setFolder: async (path) => {
		// Validate against the desktop's own disk ONLY for the local node. A remote
		// node's paths don't exist on this machine, so a local `stat` would falsely
		// reject them; the node-side list endpoint already validated existence when
		// the browser surfaced the path.
		const activeNode = useNodeStore.getState().getActiveNode();
		if (isLocalNode(activeNode)) {
			const info = await stat(path).catch(() => null);
			if (!info?.isDirectory) {
				throw new Error(`Not a valid directory: ${path}`);
			}
		}
		localStorage.setItem(STORAGE_KEY, path);
		set((state) => {
			const deduped = state.recentFolders.filter((p) => p !== path);
			const next = [path, ...deduped].slice(0, MAX_RECENTS);
			saveRecents(next);
			// (Re)importing a folder un-hides it if it was previously removed.
			const removed = state.removedProjects.filter((p) => p !== path);
			if (removed.length !== state.removedProjects.length) {
				saveRemoved(removed);
			}
			return { folder: path, recentFolders: next, removedProjects: removed };
		});
	},

	addProjectFolder: (path) => {
		set((state) => {
			const alreadyKnown = state.recentFolders.includes(path);
			const wasRemoved = state.removedProjects.includes(path);
			// Nothing to do if it's already a known, non-removed project.
			if (alreadyKnown && !wasRemoved) {
				return state;
			}
			const next = alreadyKnown
				? state.recentFolders
				: [path, ...state.recentFolders].slice(0, MAX_RECENTS);
			if (!alreadyKnown) {
				saveRecents(next);
			}
			const removed = state.removedProjects.filter((p) => p !== path);
			if (wasRemoved) {
				saveRemoved(removed);
			}
			return { recentFolders: next, removedProjects: removed };
		});
	},

	clearFolder: () => {
		localStorage.removeItem(STORAGE_KEY);
		set({ folder: null });
	},

	setProjectIcon: (path, icon) => {
		set((state) => {
			const next = { ...state.projectIcons, [path]: icon };
			saveIcons(next);
			return { projectIcons: next };
		});
	},

	clearProjectIcon: (path) => {
		set((state) => {
			if (!(path in state.projectIcons)) {
				return state;
			}
			const { [path]: _removed, ...rest } = state.projectIcons;
			saveIcons(rest);
			return { projectIcons: rest };
		});
	},

	removeRecentFolder: (path) => {
		set((state) => {
			const next = state.recentFolders.filter((p) => p !== path);
			saveRecents(next);
			const folder = state.folder === path ? null : state.folder;
			if (folder === null) {
				localStorage.removeItem(STORAGE_KEY);
			}
			return { recentFolders: next, folder };
		});
	},

	removeProject: (path) => {
		set((state) => {
			const next = state.recentFolders.filter((p) => p !== path);
			saveRecents(next);
			const removed = state.removedProjects.includes(path)
				? state.removedProjects
				: [...state.removedProjects, path];
			saveRemoved(removed);
			const folder = state.folder === path ? null : state.folder;
			if (folder === null) {
				localStorage.removeItem(STORAGE_KEY);
			}
			// Drop any custom icon so a re-imported folder starts fresh and stale
			// data URLs don't linger in localStorage.
			let projectIcons = state.projectIcons;
			if (path in projectIcons) {
				const { [path]: _dropped, ...rest } = projectIcons;
				projectIcons = rest;
				saveIcons(rest);
			}
			return {
				recentFolders: next,
				removedProjects: removed,
				folder,
				projectIcons,
			};
		});
	},

	setTerminalShell: (shell) => {
		localStorage.setItem(TERMINAL_SHELL_KEY, shell);
		set({ terminalShell: shell });
	},

	setWorktreeMode: (on) => {
		localStorage.setItem(WORKTREE_MODE_KEY, on ? "true" : "false");
		set({ worktreeMode: on });
	},

	setWorktreeBranch: (name) => {
		localStorage.setItem(WORKTREE_BRANCH_KEY, name);
		set({ worktreeBranch: name });
	},

	regenerateWorktreeBranch: () => {
		const next = suggestWorktreeBranch();
		localStorage.setItem(WORKTREE_BRANCH_KEY, next);
		set({ worktreeBranch: next });
	},
}));
