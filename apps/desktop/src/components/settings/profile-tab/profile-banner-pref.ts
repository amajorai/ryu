import {
	type MarketplaceWallpaperSelection,
	parseMarketplaceWallpaperSelection,
} from "@ryuhq/protocol/marketplace-wallpaper";

export const PROFILE_BANNER_WALLPAPER_PREF_KEY =
	"ryu.profile-banner-wallpaper.v1";

export function parseStoredProfileBanner(
	value: string
): MarketplaceWallpaperSelection | null | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed === null ? null : parseMarketplaceWallpaperSelection(parsed);
	} catch {
		return undefined;
	}
}

export function sameProfileBanner(
	left: MarketplaceWallpaperSelection | null,
	right: MarketplaceWallpaperSelection | null
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
