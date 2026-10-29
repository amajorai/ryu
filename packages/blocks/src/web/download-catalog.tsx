// Store links, browser detection, and the platform/highlight catalog behind the
// download page. Split out of ./download.tsx, which re-exports the public names,
// so consumers keep importing from there.

import { appStoreListingUrl } from "@ryu/ui/lib/ryu-app-surfaces.ts";
import { Globe, RefreshCw, Sparkles, WifiOff } from "lucide-react";
import type { SVGProps } from "react";
import {
	type DownloadArch,
	type DownloadOS,
	findReleaseWithAsset,
	type Release,
} from "./download-assets.ts";

/** Browser build of the desktop app (apps/webapp). Default :5175 in local dev. */
export const WEBAPP_URL =
	process.env.NEXT_PUBLIC_WEBAPP_URL ?? "http://localhost:5175";

export type DownloadBrowser = "chrome" | "firefox" | "edge";

export const BROWSERS: { id: DownloadBrowser; name: string }[] = [
	{ id: "chrome", name: "Chrome" },
	{ id: "firefox", name: "Firefox" },
	{ id: "edge", name: "Edge" },
];

const CHROME_EXTENSION_ID =
	process.env.NEXT_PUBLIC_EXTENSION_ID ?? "eahmgoelihpjlbejliklmfcohjhpgeml";

/**
 * Firefox (AMO slug) and Edge (add-on id) listings of the browser extension.
 * Fixed per release, not per deployment: set a value here once that store
 * publishes the extension. `null` keeps the link on a store search and keeps
 * the browser out of `hasExtensionListing`.
 */
export const EXTENSION_STORE_LISTINGS: {
	readonly edgeId: string | null;
	readonly firefoxSlug: string | null;
} = { edgeId: null, firefoxSlug: null };

export function extensionStoreUrl(browser: DownloadBrowser): string {
	if (browser === "chrome") {
		return `https://chromewebstore.google.com/detail/ryu/${CHROME_EXTENSION_ID}`;
	}
	if (browser === "firefox") {
		const slug = EXTENSION_STORE_LISTINGS.firefoxSlug;
		return slug
			? `https://addons.mozilla.org/en-US/firefox/addon/${slug}/`
			: "https://addons.mozilla.org/en-US/firefox/search/?q=ryu";
	}
	const edgeId = EXTENSION_STORE_LISTINGS.edgeId;
	return edgeId
		? `https://microsoftedge.microsoft.com/addons/detail/${edgeId}`
		: "https://microsoftedge.microsoft.com/addons/search/ryu";
}

/**
 * Whether a real store listing is configured for this browser. Chrome always has one;
 * Firefox and Edge only when EXTENSION_STORE_LISTINGS names theirs, since the fallback
 * URLs are store searches, not a listing.
 */
export function hasExtensionListing(browser: DownloadBrowser): boolean {
	if (browser === "chrome") {
		return true;
	}
	if (browser === "firefox") {
		return Boolean(EXTENSION_STORE_LISTINGS.firefoxSlug);
	}
	return Boolean(EXTENSION_STORE_LISTINGS.edgeId);
}

export type DownloadMobilePlatform = "ios" | "android";

/**
 * Public store listing for the mobile app, or `null` while that listing is not
 * configured (or is not an `https:` URL) — callers must not advertise a store
 * the app is not in.
 */
export function mobileStoreUrl(
	platform: DownloadMobilePlatform
): string | null {
	return appStoreListingUrl(
		platform === "ios"
			? process.env.NEXT_PUBLIC_IOS_APP_URL
			: process.env.NEXT_PUBLIC_ANDROID_APP_URL
	);
}

export function browserName(browser: DownloadBrowser): string {
	return (
		BROWSERS.find((candidate) => candidate.id === browser)?.name ?? "Chrome"
	);
}

const EDG_UA_RE = /edg\//i;
const FIREFOX_UA_RE = /firefox/i;

export function detectBrowser(): DownloadBrowser {
	if (globalThis.window === undefined) {
		return "chrome";
	}
	const ua = window.navigator.userAgent;
	if (EDG_UA_RE.test(ua)) {
		return "edge";
	}
	if (FIREFOX_UA_RE.test(ua)) {
		return "firefox";
	}
	return "chrome";
}

const AppleLogo = (props: SVGProps<SVGSVGElement>) => (
	<svg
		aria-hidden="true"
		focusable="false"
		viewBox="0 0 814 1000"
		xmlSpace="preserve"
		{...props}
	>
		<path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
	</svg>
);

const WindowsLogo = (props: SVGProps<SVGSVGElement>) => (
	<svg aria-hidden="true" focusable="false" viewBox="0 0 88 88" {...props}>
		<path
			d="m0 12.402 35.687-4.86.016 34.423-35.67.203zm35.67 33.529.028 34.453L.028 75.48.026 45.7zm4.326-39.025L87.314 0v41.527l-47.318.376zm47.329 39.349-.011 41.34-47.318-6.678-.066-34.739z"
			fill="currentColor"
		/>
	</svg>
);

const LinuxLogo = (props: SVGProps<SVGSVGElement>) => (
	<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" {...props}>
		<path
			d="M12.504 0c-.155 0-.315.008-.480.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489.117.804.49 1.543 1.17 2.046.61.45 1.336.602 2.04.602.36 0 .714-.04 1.045-.108.41.21.873.32 1.355.32.452 0 .892-.094 1.293-.27.41.197.85.297 1.293.297.493 0 .974-.123 1.394-.355.32.064.66.1 1.005.1.704 0 1.43-.152 2.04-.602.68-.503 1.053-1.242 1.17-2.046.123-.805-.009-1.657-.287-2.489-.589-1.771-1.831-3.47-2.716-4.521-.75-1.067-.974-1.928-1.05-3.02-.065-1.491 1.056-5.965-3.17-6.298A6.176 6.176 0 0 0 12.504 0zm.696 5.71c.319 0 .574.255.574.574 0 .318-.255.574-.574.574a.572.572 0 0 1-.574-.574c0-.319.256-.574.574-.574zm-2.32.011c.318 0 .573.256.573.574a.572.572 0 0 1-.574.574.572.572 0 0 1-.573-.574c0-.318.256-.574.574-.574z"
			fill="currentColor"
		/>
	</svg>
);

export interface DownloadPlatform {
	description: string;
	icon: React.ReactNode;
	id: DownloadOS;
	name: string;
}

// Presentation only — the filename patterns live in PLATFORM_ASSET_PATTERNS.
export const PLATFORMS: DownloadPlatform[] = [
	{
		id: "macos",
		name: "macOS",
		description: "Apple silicon and Intel Macs",
		icon: <AppleLogo className="size-6 fill-current text-foreground" />,
	},
	{
		id: "windows",
		name: "Windows",
		description: "Windows 10 or 11 (64-bit)",
		icon: <WindowsLogo className="size-6 text-info" />,
	},
	{
		id: "linux",
		name: "Linux",
		description: "Debian, Ubuntu, Fedora, and more",
		icon: <LinuxLogo className="size-6 text-foreground" />,
	},
];

export const DOWNLOAD_HIGHLIGHTS = [
	{
		title: "Runs offline",
		description:
			"Local models run entirely on your machine. You only need the internet for cloud models or sync.",
		icon: WifiOff,
	},
	{
		title: "7-day free trial",
		description:
			"Try every feature free for 7 days; local chat stays free after. Bring your own keys, with no markup.",
		icon: Sparkles,
	},
	{
		title: "Every platform",
		description:
			"Native builds for macOS (Apple silicon and Intel), plus 64-bit Windows and Linux.",
		icon: Globe,
	},
	{
		title: "Auto-updates",
		description:
			"Install once, and the app keeps itself current with each release.",
		icon: RefreshCw,
	},
];

/**
 * Verify a download URL is reachable (HEAD request).
 * Returns true if the URL returns 2xx, false otherwise.
 */
export async function verifyDownloadUrl(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, { method: "HEAD" });
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Build a direct download URL for a specific platform/arch.
 * Falls back through releases to find a valid, downloadable asset.
 */
export function buildDownloadUrl(
	releases: Release[],
	platformId: string,
	arch: DownloadArch
): { url: string; version: string } | null {
	const found = findReleaseWithAsset(releases, platformId, arch);
	if (found) {
		return {
			url: found.asset.browser_download_url,
			version: found.release.tag_name,
		};
	}
	return null;
}
