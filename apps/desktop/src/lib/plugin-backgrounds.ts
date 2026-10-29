import {
	BUNDLED_MARKETPLACE_BACKGROUNDS,
	backdropByAvailableId,
	getAvailableBackdrops,
	getMarketplaceBackdrops,
	isMarketplaceBackdropId,
	isSupportedMarketplaceBackdrop,
	type RenderableBackdrop,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import {
	type PluginBackground,
	parsePluginBackgrounds,
	pluginBackgroundSchema,
} from "@/src/lib/api/plugin-contribution-boundary.ts";

export const PLUGIN_BACKGROUNDS_STORAGE_KEY = "ryu:plugin-backgrounds";

const PLUGIN_BACKGROUNDS_CHANGED = "ryu:plugin-backgrounds:changed";
const EMPTY_BACKGROUNDS: PluginBackground[] = [];
const MARKETPLACE_DEFAULTS = BUNDLED_MARKETPLACE_BACKGROUNDS.map((background) =>
	pluginBackgroundSchema.parse(background)
);

let cachedRaw: string | null | undefined;
let cachedContributions = EMPTY_BACKGROUNDS;
let cachedBackgrounds = MARKETPLACE_DEFAULTS;

const storedBackgroundsSchema = z.object({
	version: z.literal(1),
	backgrounds: z.array(z.unknown()),
});

function supportedContributions(
	value: Parameters<typeof parsePluginBackgrounds>[0]
): PluginBackground[] {
	return parsePluginBackgrounds(value)
		.filter(isSupportedMarketplaceBackdrop)
		.map((background) => ({
			...background,
			params: Object.fromEntries(
				Object.entries(background.params).map(([key, value]) => [
					key,
					Array.isArray(value) ? [...value] : value,
				])
			),
		}));
}

function includeMarketplaceDefaults(
	contributions: readonly PluginBackground[]
): PluginBackground[] {
	const seen = new Set<string>();
	const backgrounds: PluginBackground[] = [];
	for (const background of [...MARKETPLACE_DEFAULTS, ...contributions]) {
		if (seen.has(background.id)) {
			continue;
		}
		seen.add(background.id);
		backgrounds.push(background);
	}
	return backgrounds;
}

function readCachedBackgrounds(): PluginBackground[] {
	if (!globalThis.localStorage) {
		return MARKETPLACE_DEFAULTS;
	}
	const raw = localStorage.getItem(PLUGIN_BACKGROUNDS_STORAGE_KEY);
	if (raw === cachedRaw) {
		return cachedBackgrounds;
	}
	cachedRaw = raw;
	if (!raw) {
		cachedContributions = EMPTY_BACKGROUNDS;
		cachedBackgrounds = MARKETPLACE_DEFAULTS;
		return cachedBackgrounds;
	}
	try {
		const parsed = storedBackgroundsSchema.safeParse(JSON.parse(raw));
		cachedContributions = parsed.success
			? supportedContributions(parsed.data.backgrounds)
			: EMPTY_BACKGROUNDS;
		cachedBackgrounds = includeMarketplaceDefaults(cachedContributions);
	} catch {
		cachedContributions = EMPTY_BACKGROUNDS;
		cachedBackgrounds = MARKETPLACE_DEFAULTS;
	}
	return cachedBackgrounds;
}

function subscribeToBackgroundChanges(onChange: () => void): () => void {
	if (!globalThis.window) {
		return () => undefined;
	}
	const onStorage = (event: StorageEvent) => {
		if (event.key !== null && event.key !== PLUGIN_BACKGROUNDS_STORAGE_KEY) {
			return;
		}
		cachedRaw = undefined;
		readCachedBackgrounds();
		onChange();
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener(PLUGIN_BACKGROUNDS_CHANGED, onChange);
	return () => {
		window.removeEventListener("storage", onStorage);
		window.removeEventListener(PLUGIN_BACKGROUNDS_CHANGED, onChange);
	};
}

/** Cached contribution data remains available to the launch chooser while Core is offline. */
export function loadPluginBackgrounds(): PluginBackground[] {
	return readCachedBackgrounds();
}

/** Replace the offline resolution table with the complete, validated Core view. */
export function savePluginBackgrounds(
	value: Parameters<typeof parsePluginBackgrounds>[0]
): PluginBackground[] {
	const next = supportedContributions(value);
	const current = readCachedBackgrounds();
	if (JSON.stringify(cachedContributions) === JSON.stringify(next)) {
		return current;
	}
	cachedContributions = next;
	cachedBackgrounds = includeMarketplaceDefaults(next);
	try {
		localStorage.setItem(
			PLUGIN_BACKGROUNDS_STORAGE_KEY,
			JSON.stringify({ backgrounds: next, version: 1 })
		);
		cachedRaw = localStorage.getItem(PLUGIN_BACKGROUNDS_STORAGE_KEY);
	} catch {
		try {
			cachedRaw = localStorage.getItem(PLUGIN_BACKGROUNDS_STORAGE_KEY);
		} catch {
			cachedRaw = undefined;
		}
	}
	if (globalThis.window) {
		window.dispatchEvent(new Event(PLUGIN_BACKGROUNDS_CHANGED));
	}
	return next;
}

export function usePluginBackgrounds(): PluginBackground[] {
	return useSyncExternalStore(
		subscribeToBackgroundChanges,
		readCachedBackgrounds,
		() => MARKETPLACE_DEFAULTS
	);
}

export function isPluginBackgroundId(value: string): boolean {
	return isMarketplaceBackdropId(value);
}

export type { RenderableBackdrop };
export {
	backdropByAvailableId,
	getAvailableBackdrops,
	getMarketplaceBackdrops,
};
