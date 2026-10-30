import { iconToUrl } from "@ryu/ui/components/icon.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchApps } from "@/src/lib/api/plugins.ts";
import { inlineToDataUrl } from "./PluginHostPanel-host-media.ts";

/** Module-level cache of resolved app icon tiles (`appId` → `{ name, glyph,
 *  background }`), so the notifications bridge never re-fetches the catalog or
 *  re-inlines the same icon on every row render. Keyed by `nodeUrl|appId` so two
 *  nodes with different catalogs cannot cross-pollute. */
const appIconTileCache = new Map<string, AppIconTile>();

interface AppIconTile {
	background: string | null;
	glyph: string;
	name: string;
}

/**
 * Resolve an app's notification tile (name + monochrome glyph as a `data:` URL +
 * flat plate background) for the CSP-locked companion frame. Falls back to a
 * neutral glyph for unknown / legacy producers (rows with no `source_app_id`),
 * so every notification row can render SOMETHING specific to its sender.
 */
export async function resolveAppIconTile(
	target: ApiTarget,
	appId: string
): Promise<AppIconTile> {
	const cacheKey = `${target.url}|${appId}`;
	const cached = appIconTileCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	let tile: AppIconTile;
	try {
		const apps = await fetchApps(target);
		const app = apps.find((a) => a.id === appId);
		if (app) {
			const rasterUrl =
				app.iconUrl ??
				iconToUrl(app.icon, {
					size: 28,
					// Muted-foreground zinc-500: reads on the neutral plate in both themes.
					color: "#71717b",
				});
			tile = {
				background: app.iconBackground ?? null,
				glyph: rasterUrl ? await inlineToDataUrl(rasterUrl) : "",
				name: app.name,
			};
		} else {
			tile = { background: null, glyph: "", name: appId };
		}
	} catch {
		tile = { background: null, glyph: "", name: appId };
	}
	appIconTileCache.set(cacheKey, tile);
	return tile;
}
