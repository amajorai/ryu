"use client";

import { iconifyPath } from "@ryu/ui/components/glyph.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import type { CSSProperties } from "react";
import { cn } from "../lib/utils.ts";

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
 *  - A ready HTTP(S) image URL or a safe raster `data:image` URI.
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
		const safeUrl = safeMediaUrl(trimmed);
		return safeUrl &&
			(safeUrl.startsWith("http:") ||
				safeUrl.startsWith("https:") ||
				safeUrl.startsWith("data:image/"))
			? safeUrl
			: null;
	}
	const path = iconifyPath(trimmed);
	if (!path) {
		return null;
	}
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

/** CSS inputs owned by the registered icon mask stylesheet. */
interface IconVariables extends CSSProperties {
	"--ryu-icon-mask": string;
	"--ryu-icon-size": string;
}

export type PanelIconPresentation = "panel-tab" | "panel-launchpad";

/** Exact shared glyph treatment on each native dock-tab/icon root. */
export function panelIconPresentationClasses(
	presentation: PanelIconPresentation | undefined
) {
	return cn(
		presentation === "panel-tab" &&
			"transition-[scale,opacity] duration-150 group-focus-within/tab:scale-50 group-focus-within/tab:opacity-0 group-hover/tab:scale-50 group-hover/tab:opacity-0",
		presentation === "panel-launchpad" &&
			"text-muted-foreground transition-colors group-hover:text-foreground"
	);
}

interface IconProps {
	className?: string;
	/** Icon id — an Iconify/icons0 `prefix:name`, a bare Hugeicons name, or a URL. */
	icon: string | null | undefined;
	/** Accessible label; omit (or "") for a decorative icon. */
	label?: string;
	motion?: "opacity";
	presentation?: PanelIconPresentation;
	/** Rendered edge length in px (drives both the box and the fetched size). */
	size?: number;
	tone?: "default" | "muted";
	visibility?: "concealed" | "row-hover";
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
export function Icon({
	icon,
	size = 16,
	className,
	label,
	tone = "default",
	motion,
	visibility,
	presentation,
}: IconProps) {
	const url = iconToUrl(icon, { size });
	if (!url) {
		return null;
	}
	const hasValidSize = Number.isFinite(size) && size >= 0;
	const presentationClasses = cn(
		tone === "muted" && "text-muted-foreground",
		motion === "opacity" && "transition-opacity",
		visibility === "concealed" && "opacity-0",
		visibility === "row-hover" &&
			"opacity-100 group-hover/row:opacity-0 group-focus-visible/row:opacity-0 group-has-[button:focus-visible]/row:opacity-0"
	);
	const style: IconVariables = {
		"--ryu-icon-size": `${size}px`,
		"--ryu-icon-mask": `url("${url}")`,
	};
	return (
		<span
			aria-hidden={label ? undefined : true}
			aria-label={label || undefined}
			className={cn(
				"ryu-registered-icon",
				hasValidSize && "ryu-registered-icon-sized",
				presentationClasses,
				panelIconPresentationClasses(presentation),
				className
			)}
			role={label ? "img" : undefined}
			style={style}
		/>
	);
}
