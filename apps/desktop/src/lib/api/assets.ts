// apps/desktop/src/lib/api/assets.ts
//
// Client for the shared asset picker: searchable icons, brand logos, and GIFs.
//
// - Icons  → Iconify API (api.iconify.design): free, no key, CORS-open, hosts
//   200k+ icons across 150+ sets INCLUDING Lucide and Hugeicons in one API, so a
//   single integration covers every icon set.
// - Logos  → SVGL API (api.svgl.app): free, no key, CORS-open brand/product SVGs.
// - GIFs   → Core `/api/gifs/search` proxy (a free provider key lives on the node,
//   never in this bundle — see apps/core/src/server/gifs.rs). No provider is truly
//   keyless, so GIFs need a key configured; icons + logos work with zero setup.
//
// The picker hands its host surface an {@link AssetSelection}: an SVG string (icon
// or logo) or a GIF URL. Each surface (whiteboard, canvas) adapts that into its
// own element/node.

import { type ApiTarget, request } from "./client.ts";

const ICONIFY_BASE = "https://api.iconify.design";
const SVGL_BASE = "https://api.svgl.app";

/** A single icon hit: an Iconify id like `lucide:heart` or `hugeicons:home-01`. */
export interface IconHit {
	/** Iconify id (`prefix:name`). */
	id: string;
	/** Small preview SVG URL for the grid (rendered mid-gray for either theme). */
	previewUrl: string;
}

/** A brand/product logo from SVGL. */
export interface LogoHit {
	/** Full-color SVG URL (light variant) to preview and fetch. */
	svgUrl: string;
	title: string;
}

/** A normalized GIF from the Core proxy (mirrors `GifResult` in gifs.rs). */
export interface GifHit {
	height: number;
	id: string;
	preview_url: string;
	title: string;
	url: string;
	width: number;
}

/** Envelope returned by `GET /api/gifs/search`. */
export interface GifSearchResponse {
	/** False when the node has no GIF provider key configured. */
	configured: boolean;
	error?: string;
	provider: string;
	results: GifHit[];
}

/** What the picker returns to its host when the user picks an asset. */
export type AssetSelection =
	| { kind: "svg"; svg: string; name: string }
	| { kind: "gif"; url: string; name: string; width?: number; height?: number };

/** Encode SVG markup as a base64 data URL (base64 handles any unicode content). */
export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/** Build the Iconify SVG URL for an id, optionally forcing a color/size. */
export function iconSvgUrl(
	id: string,
	opts: { color?: string; size?: number } = {}
): string {
	const path = id.replace(":", "/");
	const params = new URLSearchParams();
	if (opts.color) {
		params.set("color", opts.color);
	}
	if (opts.size) {
		params.set("width", String(opts.size));
		params.set("height", String(opts.size));
	}
	const qs = params.toString();
	return `${ICONIFY_BASE}/${path}.svg${qs ? `?${qs}` : ""}`;
}

/**
 * Search Iconify for icons matching `query`. Returns ids like `lucide:heart`.
 * With an empty query returns a small curated starter set so the tab isn't blank.
 */
export async function searchIcons(
	query: string,
	limit = 48
): Promise<IconHit[]> {
	const q = query.trim();
	const url = q
		? `${ICONIFY_BASE}/search?query=${encodeURIComponent(q)}&limit=${limit}`
		: `${ICONIFY_BASE}/collection?prefix=lucide`;
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`icon search failed: ${resp.status}`);
	}
	const data = (await resp.json()) as {
		icons?: string[];
		// The collection endpoint returns `{ uncategorized: string[], categories }`.
		uncategorized?: string[];
		categories?: Record<string, string[]>;
	};
	let ids: string[];
	if (q) {
		ids = data.icons ?? [];
	} else {
		// Collection response: names are bare (no prefix); prepend `lucide:`.
		const names = [
			...(data.uncategorized ?? []),
			...Object.values(data.categories ?? {}).flat(),
		].slice(0, limit);
		ids = names.map((n) => `lucide:${n}`);
	}
	return ids.map((id) => ({
		id,
		previewUrl: iconSvgUrl(id, { color: "#888888" }),
	}));
}

/**
 * Fetch the raw SVG markup for an icon, colored so it renders predictably when
 * embedded (an embedded `currentColor` icon would otherwise fall back to black
 * with no CSS context). `color` defaults to a near-black that reads on light
 * boards; brand logos keep their own colors (see {@link fetchSvgText}).
 */
export async function fetchIconSvg(
	id: string,
	color = "#111827"
): Promise<string> {
	const resp = await fetch(iconSvgUrl(id, { color }));
	if (!resp.ok) {
		throw new Error(`icon fetch failed: ${resp.status}`);
	}
	return await resp.text();
}

/**
 * Search SVGL for brand logos. Empty query returns the default catalog page.
 * Each entry's `route` is a raw SVG URL (or a `{ light, dark }` pair — we take
 * the light variant for the preview + fetch).
 */
export async function searchLogos(query: string): Promise<LogoHit[]> {
	const q = query.trim();
	const url = q ? `${SVGL_BASE}?search=${encodeURIComponent(q)}` : SVGL_BASE;
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`logo search failed: ${resp.status}`);
	}
	// The search endpoint 404s when nothing matches; treat as empty.
	const data = (await resp.json().catch(() => [])) as Array<{
		title: string;
		route: string | { light: string; dark: string };
	}>;
	if (!Array.isArray(data)) {
		return [];
	}
	return data.map((item) => ({
		title: item.title,
		svgUrl: typeof item.route === "string" ? item.route : item.route.light,
	}));
}

/** Fetch raw SVG markup from a URL (used for brand logos, kept full-color). */
export async function fetchSvgText(url: string): Promise<string> {
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`svg fetch failed: ${resp.status}`);
	}
	return await resp.text();
}

/** Search GIFs via the Core proxy (empty query ⇒ trending). */
export async function searchGifs(
	target: ApiTarget,
	query: string,
	limit = 24
): Promise<GifSearchResponse> {
	const q = encodeURIComponent(query.trim());
	return await request<GifSearchResponse>(
		target,
		`/api/gifs/search?q=${q}&limit=${limit}`
	);
}
