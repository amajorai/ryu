import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { isPluginBackgroundId } from "./plugin-backgrounds.ts";

export const WALLPAPER_LIBRARY_STORAGE_KEY = "ryu:wallpaper-library";

const WALLPAPER_LIBRARY_CHANGED = "ryu:wallpaper-library:changed";
const MAX_INSTALLED_WALLPAPERS = 1024;
const MAX_STORED_CHARACTERS = 262_144;
const EMPTY_IDS: readonly string[] = [];

let cachedRaw: string | null | undefined;
let cachedIds: readonly string[] = EMPTY_IDS;

const installedWallpaperStorageSchema = z.object({
	version: z.literal(1),
	ids: z.array(appResponseValueSchema.nonoptional()),
});
const installedWallpaperIdSchema = z.string().refine(isPluginBackgroundId);

/** Parse the small versioned id list without trusting localStorage contents. */
export function parseInstalledWallpaperIds(raw: string | null): string[] {
	if (!raw || raw.length > MAX_STORED_CHARACTERS) {
		return [];
	}
	try {
		const parsed = installedWallpaperStorageSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return [];
		}
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const rawId of parsed.data.ids.slice(0, MAX_INSTALLED_WALLPAPERS)) {
			const parsedId = installedWallpaperIdSchema.safeParse(rawId);
			if (!parsedId.success || seen.has(parsedId.data)) {
				continue;
			}
			const id = parsedId.data;
			seen.add(id);
			ids.push(id);
		}
		return ids;
	} catch {
		return [];
	}
}

function readRaw(): string | null {
	try {
		return globalThis.localStorage === undefined
			? null
			: localStorage.getItem(WALLPAPER_LIBRARY_STORAGE_KEY);
	} catch {
		return null;
	}
}

export function loadInstalledWallpaperIds(): readonly string[] {
	const raw = readRaw();
	if (raw === cachedRaw) {
		return cachedIds;
	}
	cachedRaw = raw;
	cachedIds = parseInstalledWallpaperIds(raw);
	return cachedIds;
}

function publishInstalledIds(ids: readonly string[]): boolean {
	if (globalThis.window === undefined) {
		return false;
	}
	const serialized = JSON.stringify({ ids, version: 1 });
	if (serialized.length > MAX_STORED_CHARACTERS) {
		return false;
	}
	try {
		window.localStorage.setItem(WALLPAPER_LIBRARY_STORAGE_KEY, serialized);
		cachedRaw = serialized;
		cachedIds = ids;
		window.dispatchEvent(new Event(WALLPAPER_LIBRARY_CHANGED));
		return true;
	} catch {
		return false;
	}
}

function subscribe(onChange: () => void): () => void {
	if (globalThis.window === undefined) {
		return () => undefined;
	}
	const onStorage = (event: StorageEvent) => {
		if (event.key !== null && event.key !== WALLPAPER_LIBRARY_STORAGE_KEY) {
			return;
		}
		cachedRaw = undefined;
		loadInstalledWallpaperIds();
		onChange();
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener(WALLPAPER_LIBRARY_CHANGED, onChange);
	return () => {
		window.removeEventListener("storage", onStorage);
		window.removeEventListener(WALLPAPER_LIBRARY_CHANGED, onChange);
	};
}

export function useInstalledWallpaperIds(): readonly string[] {
	return useSyncExternalStore(
		subscribe,
		loadInstalledWallpaperIds,
		() => EMPTY_IDS
	);
}

export function installWallpaper(id: string): boolean {
	if (!isPluginBackgroundId(id)) {
		return false;
	}
	const current = loadInstalledWallpaperIds();
	if (current.includes(id)) {
		return true;
	}
	if (current.length >= MAX_INSTALLED_WALLPAPERS) {
		return false;
	}
	return publishInstalledIds([...current, id]);
}

export function uninstallWallpaper(id: string): boolean {
	const current = loadInstalledWallpaperIds();
	const next = current.filter((installedId) => installedId !== id);
	return next.length < current.length && publishInstalledIds(next);
}
