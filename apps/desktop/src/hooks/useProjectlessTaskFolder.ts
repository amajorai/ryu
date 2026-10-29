import { useCallback, useSyncExternalStore } from "react";
import { registerSetting } from "@/src/lib/settings-registry.ts";
import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";

/** Folder used as the working directory for new chats without a project. */
export const PROJECTLESS_TASK_FOLDER_KEY = "ryu:projectless-task-folder";

const listeners = new Set<() => void>();
const DEFAULT_PROJECTLESS_TASK_FOLDER_COMMAND =
	"get_default_projectless_task_folder";

interface ProjectlessTaskFolderSnapshot {
	customFolder: string | null;
	folder: string | null;
}

const EMPTY_FOLDER_SNAPSHOT: ProjectlessTaskFolderSnapshot = {
	customFolder: null,
	folder: null,
};

let defaultFolder: string | null = null;
let defaultFolderPromise: Promise<string | null> | null = null;

function readFolder(): string | null {
	try {
		const value = localStorage.getItem(PROJECTLESS_TASK_FOLDER_KEY)?.trim();
		return value || null;
	} catch {
		return null;
	}
}

let cachedFolder = readFolder();
let snapshot: ProjectlessTaskFolderSnapshot = {
	customFolder: cachedFolder,
	folder: cachedFolder,
};

function publishSnapshot(): void {
	snapshot = {
		customFolder: cachedFolder,
		folder: cachedFolder ?? defaultFolder,
	};
	for (const callback of listeners) {
		callback();
	}
}

/** Resolve the native Documents location and create Documents/Ryu/Projects. */
export function initializeProjectlessTaskFolder(): Promise<string | null> {
	if (!defaultFolderPromise) {
		defaultFolderPromise = invokeWhenReady<string>(
			DEFAULT_PROJECTLESS_TASK_FOLDER_COMMAND
		)
			.then((folder) => folder.trim() || null)
			.catch(() => null)
			.then((folder) => {
				defaultFolder = folder;
				publishSnapshot();
				return folder;
			});
	}
	return defaultFolderPromise;
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === PROJECTLESS_TASK_FOLDER_KEY) {
			cachedFolder = readFolder();
			publishSnapshot();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(callback);
		window.removeEventListener("storage", onStorage);
	};
}

export function setProjectlessTaskFolder(folder: string | null): void {
	cachedFolder = folder?.trim() || null;
	try {
		if (cachedFolder) {
			localStorage.setItem(PROJECTLESS_TASK_FOLDER_KEY, cachedFolder);
		} else {
			localStorage.removeItem(PROJECTLESS_TASK_FOLDER_KEY);
		}
	} catch {
		// Persistence is best effort; the current session still uses the new value.
	}
	publishSnapshot();
}

export function useProjectlessTaskFolder(): [
	string | null,
	(folder: string | null) => void,
	boolean,
] {
	const folderSnapshot = useSyncExternalStore(
		subscribe,
		() => snapshot,
		() => EMPTY_FOLDER_SNAPSHOT
	);
	const setFolder = useCallback(
		(next: string | null) => setProjectlessTaskFolder(next),
		[]
	);
	return [
		folderSnapshot.folder,
		setFolder,
		folderSnapshot.customFolder !== null,
	];
}

registerSetting({
	category: "general",
	id: "general.projectless-task-folder",
	label: "Projectless task folder",
	reset: () => setProjectlessTaskFolder(null),
});
