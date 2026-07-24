"use client";

import type { CSSProperties } from "react";

// Iconify's public SVG API. icons0.dev is Iconify-powered (it redistributes the
// same collections via a shadcn registry), so a single Iconify resolver covers
// BOTH catalogs — 200k+ icons across 150+ sets — plus the Hugeicons set the rest
// of the app authors against. Whiteboard/canvas already call this same host
// (behind their CSP allowlist); the desktop shell CSP must allow it in `img-src`.
const ICONIFY_API = "https://api.iconify.design";

const URL_OR_DATA = /^(https?:|data:)/;

/**
 * Resolve an app-registered icon id to a hosted SVG URL. Supported id shapes:
 *
 *  - Iconify / icons0.dev id — `"prefix:name"` (e.g. `"lucide:heart"`,
 *    `"mdi:home"`, `"tabler:mic"`). Any of the 150+ collections resolve.
 *  - Bare name — `"ai-image"`, `"mic-01"`, `"shapes"` — treated as the Hugeicons
 *    set (`hugeicons:<name>`), which is how the built-in app manifests author
 *    their `companion.icon`.
 *  - A ready image URL or inline `data:` URI — returned unchanged.
 *
 * Returns `null` for an empty id so callers can fall back to a default glyph.
 */
export function iconToUrl(
	icon: string | null | undefined,
	opts: { size?: number; color?: string } = {}
): string | null {
	const trimmed = icon?.trim();
	if (!trimmed) {
		return null;
	}
	if (URL_OR_DATA.test(trimmed)) {
		return trimmed;
	}
	// `prefix:name` → that Iconify collection; a bare name → the Hugeicons set.
	const id = trimmed.includes(":") ? trimmed : `hugeicons:${trimmed}`;
	const path = id.replace(":", "/");
	const params = new URLSearchParams();
	if (opts.size) {
		params.set("width", String(opts.size));
		params.set("height", String(opts.size));
	}
	if (opts.color) {
		params.set("color", opts.color);
	}
	const qs = params.toString();
	return `${ICONIFY_API}/${path}.svg${qs ? `?${qs}` : ""}`;
}

interface IconProps {
	className?: string;
	/** Icon id — an Iconify/icons0 `prefix:name`, a bare Hugeicons name, or a URL. */
	icon: string | null | undefined;
	/** Accessible label; omit (or "") for a decorative icon. */
	label?: string;
	/** Rendered edge length in px (drives both the box and the fetched size). */
	size?: number;
}

/**
 * Render any registered icon by id, resolved through {@link iconToUrl}. The glyph
 * is painted with a CSS mask so it inherits `currentColor` (stays theme-aware)
 * instead of being a fixed-color raster — the same reason the app's static
 * Hugeicons glyphs inherit text color. Monochrome/line icons render ideally;
 * multi-color sets flatten to a single-color silhouette.
 *
 * Shared primitive so apps (companions, spaces, marketplace cards) all render
 * icons the same way rather than each re-implementing name→glyph resolution.
 */
export function Icon({ icon, size = 16, className, label }: IconProps) {
	const url = iconToUrl(icon, { size });
	if (!url) {
		return null;
	}
	const style: CSSProperties = {
		backgroundColor: "currentColor",
		display: "inline-block",
		height: size,
		maskImage: `url("${url}")`,
		maskPosition: "center",
		maskRepeat: "no-repeat",
		maskSize: "contain",
		WebkitMaskImage: `url("${url}")`,
		WebkitMaskPosition: "center",
		WebkitMaskRepeat: "no-repeat",
		WebkitMaskSize: "contain",
		width: size,
	};
	return (
		<span
			aria-hidden={label ? undefined : true}
			aria-label={label || undefined}
			className={className}
			role={label ? "img" : undefined}
			style={style}
		/>
	);
}
