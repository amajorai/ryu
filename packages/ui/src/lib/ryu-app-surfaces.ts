/**
 * The installable Ryu clients every user nav cross-promotes. Each surface
 * offers the others ("Get Ryu apps"), never itself; the web app is where the
 * links land, so it is a surface that upsells but is never upsold.
 *
 * Paths are website-relative and anchor into the matching `/download` section,
 * so callers prefix them with their own website origin.
 */

export type RyuAppSurfaceId = "desktop" | "extension" | "mobile";
export type RyuCurrentSurface = RyuAppSurfaceId | "web";

export interface RyuAppSurface {
	description: string;
	id: RyuAppSurfaceId;
	label: string;
	path: `/download#${RyuAppSurfaceId}`;
}

export const RYU_APP_SURFACES: readonly RyuAppSurface[] = [
	{
		id: "desktop",
		label: "Desktop app",
		description: "macOS, Windows, and Linux",
		path: "/download#desktop",
	},
	{
		id: "extension",
		label: "Browser extension",
		description: "Chrome, Firefox, and Edge",
		path: "/download#extension",
	},
	{
		id: "mobile",
		label: "Mobile app",
		description: "iOS and Android",
		path: "/download#mobile",
	},
];

export const GET_RYU_APPS_LABEL = "Get Ryu apps";

export interface OtherRyuAppSurfacesOptions {
	/**
	 * Whether this build knows an app-store listing for the mobile app. Without
	 * one, `/download#mobile` has nothing to install, so Mobile is not promoted.
	 */
	mobileListed?: boolean;
}

/** The surfaces to promote from `current`, in catalog order. */
export function otherRyuAppSurfaces(
	current: RyuCurrentSurface,
	{ mobileListed = false }: OtherRyuAppSurfacesOptions = {}
): RyuAppSurface[] {
	return RYU_APP_SURFACES.filter(
		(surface) =>
			surface.id !== current && (surface.id !== "mobile" || mobileListed)
	);
}

/**
 * A configured app-store listing, or `null` when the value is unset, blank, or
 * not an absolute `https:` URL. Callers must not advertise a store the app is
 * not in, nor put an arbitrary build value into a link.
 */
export function appStoreListingUrl(
	value: string | null | undefined
): string | null {
	const candidate = value?.trim();
	if (!candidate) {
		return null;
	}
	try {
		return new URL(candidate).protocol === "https:" ? candidate : null;
	} catch {
		return null;
	}
}

/** Whether at least one of the given mobile store listings is configured. */
export function hasMobileStoreListing(
	...listings: Array<string | null | undefined>
): boolean {
	return listings.some((listing) => appStoreListingUrl(listing) !== null);
}
