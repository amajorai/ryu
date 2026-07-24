// packages/marketplace/src/catalog/icon-url.ts
//
// Catalog icons come from two manifest fields: `icon` (an Icon-primitive id like
// `lucide:brain` or a bare Hugeicons name) and `icon_url` (a raster logo). A
// publisher naturally reaches for the `icon` field and pastes an image URL there
// too — so we accept a URL in EITHER field, but only when it is served from the
// GitHub image CDN. That keeps the surface useful (GitHub is where plugin repos
// already host their art) without turning an icon field into an arbitrary remote
// fetch that could phone home or track an install via the image load.

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
}: {
	icon?: string | null;
	iconUrl?: string | null;
}): { iconId?: string | null; iconUrl?: string | null } {
	// A GitHub-image URL in the `icon` field is promoted to the raster slot; a
	// non-GitHub URL there is discarded (never passed on as an Icon id).
	const rasterFromIcon = isGithubImageUrl(icon) ? icon : null;
	const resolvedIconId = icon && !isHttpUrl(icon) ? icon : null;
	return {
		iconId: resolvedIconId,
		iconUrl: (iconUrl ?? null) || rasterFromIcon,
	};
}
