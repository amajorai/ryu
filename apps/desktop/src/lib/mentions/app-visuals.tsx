import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import { z } from "zod";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import type { MentionSourceItem } from "@/src/lib/mentions/types.ts";

const SAFE_FLAT_COLOR =
	/^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^()]{1,96}\)|[a-z]{1,24})$/i;

function safeFlatColor(value: string | undefined | null): string | undefined {
	const trimmed = value?.trim();
	return trimmed && SAFE_FLAT_COLOR.test(trimmed) ? trimmed : undefined;
}

function ditherAccent(
	value: string | number | null | undefined
): string | undefined {
	const hue = z.number().safeParse(value);
	if (hue.success) {
		return `hsl(${Math.round(hue.data) % 360} 72% 48%)`;
	}
	const color = z.string().safeParse(value);
	return safeFlatColor(color.success ? color.data : undefined);
}

function appAccentColor(app: AppInfo): string | undefined {
	return (
		safeFlatColor(app.accentColor) ??
		safeFlatColor(app.iconBackground) ??
		ditherAccent(app.iconDither?.from)
	);
}

/** Reuse the same app icon data the sidebar, Store, and Launchpad already use. */
export function appMentionVisual(
	app: AppInfo | undefined
): Pick<MentionSourceItem, "accentColor" | "visualIcon"> {
	if (!app) {
		return {};
	}

	return {
		accentColor: appAccentColor(app),
		visualIcon: (
			<AppIcon
				cacheKey={iconCacheKey(app.id, app.installedVersion ?? app.version)}
				className="size-3.5 shrink-0"
				corners="mention"
				dither={app.iconDither}
				iconBackground={app.iconBackground}
				iconId={app.icon}
				iconPadding={app.iconPadding}
				iconUrl={app.iconUrl}
				name={app.name}
				seedId={app.id}
				size={14}
			/>
		),
	};
}
