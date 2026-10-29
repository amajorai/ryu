import { useEffect } from "react";
import { usePluginContributionsQuery } from "@/src/hooks/usePluginContributions.ts";
import { savePluginBackgrounds } from "@/src/lib/plugin-backgrounds.ts";
import {
	clearUnavailableBackdrop,
	readWallpaperPreference,
	writeWallpaperPreference,
} from "@/src/lib/wallpaper.ts";

/**
 * Keep the offline backdrop-resolution cache aligned with enabled plugins.
 * Only a successful Core response replaces it; loading and offline errors keep
 * the last known set available to the startup chooser.
 */
export function usePluginBackgroundSync(): void {
	const { data, isSuccess } = usePluginContributionsQuery();
	const backgrounds = data?.backgrounds;

	useEffect(() => {
		if (!(isSuccess && backgrounds)) {
			return;
		}

		const selected = readWallpaperPreference();
		const next = savePluginBackgrounds(backgrounds);
		const reconciled = clearUnavailableBackdrop(selected, next);
		if (reconciled !== selected) {
			writeWallpaperPreference(reconciled);
		}
	}, [backgrounds, isSuccess]);
}
