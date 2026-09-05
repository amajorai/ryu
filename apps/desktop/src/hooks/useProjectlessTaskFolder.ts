import { useCallback, useSyncExternalStore } from "react";
import { registerSetting } from "@/src/lib/settings-registry.ts";

/** Folder used as the working directory for new chats without a project. */
export const PROJECTLESS_TASK_FOLDER_KEY = "ryu:projectless-task-folder";

const listeners = new Set<() => void>();

function readFolder(): string | null {
	try {
		const value = localStorage.getItem(PROJECTLESS_TASK_FOLDER_KEY)?.trim();
		return value || null;
	} catch {
		return null;
	}
}

let cachedFolder = readFolder();

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === PROJECTLESS_TASK_FOLDER_KEY) {
			cachedFolder = readFolder();
			callback();
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
	for (const callback of listeners) {
		callback();
	}
}

export function useProjectlessTaskFolder(): [
	string | null,
	(folder: string | null) => void,
] {
	const folder = useSyncExternalStore(
		subscribe,
		() => cachedFolder,
		() => null
	);
	const setFolder = useCallback(
		(next: string | null) => setProjectlessTaskFolder(next),
		[]
	);
	return [folder, setFolder];
}

registerSetting({
	category: "general",
	id: "general.projectless-task-folder",
	label: "Projectless task folder",
	reset: () => setProjectlessTaskFolder(null),
});
