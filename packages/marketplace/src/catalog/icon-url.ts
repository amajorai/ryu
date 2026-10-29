// packages/marketplace/src/catalog/icon-url.ts
//
// Catalog icons come from two manifest fields: `icon` (an Icon-primitive id like
// `lucide:brain` or a bare Hugeicons name) and `icon_url` (a raster logo). A
// publisher naturally reaches for the `icon` field and pastes an image URL there
// too — so we accept a URL in EITHER field, but only when it is served from the
// GitHub image CDN. That keeps the surface useful (GitHub is where plugin repos
// already host their art) without turning an icon field into an arbitrary remote
// fetch that could phone home or track an install via the image load.
//
// A third shape, `svgl:<slug>`, names a brand mark on svgl.app's public CDN (see
// `@ryu/ui/components/svgl.ts`). It is a fixed, keyless asset host — the same
// posture as the Iconify host the Icon primitive already fetches from — so a
// branded listing (Brave, Firecrawl, Notion, …) can carry its real logo without
// every publisher pasting a raw URL.

import {
	isSvglIcon,
	resolveSvglIcon,
	type SvglRoute,
} from "@ryu/ui/components/svgl.ts";

/** Artwork slots resolved from publisher icon fields and the current brand index. */
export interface ResolvedCardIcon {
	/** Brand marks retain their colours and are letterboxed rather than cropped. */
	brand?: boolean;
	iconId?: string | null;
	iconUrl?: string | null;
	iconUrlDark?: string | null;
}

/** GitHub image CDN hosts. Every `*.githubusercontent.com` subdomain
 *  (`raw`, `user-images`, `avatars`, `camo`, `objects`, `private-user-images`)
 *  serves image bytes; `github.com` itself only for release/attachment `/assets/`
 *  and `/raw/` paths, which 302 to a githubusercontent host. */
export function isGithubImageUrl(value: string | null | undefined): boolean {
	if (!value) {
		return false;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") {
		return false;
	}
	const host = url.hostname.toLowerCase();
	if (
		host === "githubusercontent.com" ||
		host.endsWith(".githubusercontent.com")
	) {
		return true;
	}
	if (host === "github.com") {
		return url.pathname.includes("/assets/") || url.pathname.includes("/raw/");
	}
	return false;
}

/** True for any `http(s)://` string, so a URL mistakenly left in the `icon`
 *  (Icon-primitive) field is never forwarded to the Icon primitive as an id. */
export function isHttpUrl(value: string | null | undefined): boolean {
	if (!value) {
		return false;
	}
	return /^https?:\/\//i.test(value);
}

/** Resolve a card's two icon fields into what the renderer should actually use:
 *  a raster `iconUrl` and an Icon-primitive `iconId` (only when `icon` is a real
 *  id, never a URL).
 *
 *  An `svgl:<slug>` id is neither: it names a BRAND mark, which must keep its own
 *  colours, so it resolves to the raster slot (a real `<img>`) rather than to the
 *  Icon primitive, whose CSS mask would flatten it to a `currentColor` silhouette.
 *  See {@link resolveSvglIcon}; the caller passes the loaded svgl index so a brand
 *  with a dark-theme variant gets one.
 *
 *  `icon_url` is the dedicated raster slot — publisher-declared logo art, already
 *  rendered for any `https:` host (the app CSP permits `img-src https:`), so it is
 *  passed through unchanged; that keeps first-party integration logos (Composio,
 *  integrations.sh CDNs) working. The GitHub-image allowlist applies ONLY to a URL
 *  mistakenly pasted into the `icon` (Icon-primitive) field: it is promoted to the
 *  raster slot when it is a GitHub image, and otherwise dropped so a stray tracker
 *  URL never reaches the Icon primitive or gets fetched. */
export function resolveCardIcon({
	icon,
	iconUrl,
	svglIndex = null,
}: {
	icon?: string | null;
	iconUrl?: string | null;
	/** svgl's loaded brand index, or null before it lands — see {@link useSvglIndex}. */
	svglIndex?: Map<string, SvglRoute> | null;
}): ResolvedCardIcon {
	// A brand id resolves to the raster slot in the brand's own colours. The
	// publisher-declared `icon_url` still wins — it is the more specific claim.
	const svgl = resolveSvglIcon(icon, svglIndex);
	if (svgl && !iconUrl) {
		return {
			iconId: null,
			iconUrl: svgl.light,
			iconUrlDark: svgl.dark,
			brand: true,
		};
	}
	// A GitHub-image URL in the `icon` field is promoted to the raster slot; a
	// non-GitHub URL there is discarded (never passed on as an Icon id).
	const rasterFromIcon = isGithubImageUrl(icon) ? icon : null;
	const resolvedIconId =
		icon && !(isHttpUrl(icon) || isSvglIcon(icon)) ? icon : null;
	return {
		iconId: resolvedIconId,
		iconUrl: (iconUrl ?? null) || rasterFromIcon,
		iconUrlDark: null,
		brand: false,
	};
}
