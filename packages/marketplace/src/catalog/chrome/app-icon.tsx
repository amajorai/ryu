// Canonical app/plugin tile: layered material, preserved artwork and offline caching.

import AppIconArtwork, {
	type AppIconPresentation,
	appIconPresentationClasses,
	composerIconFor,
} from "@ryu/ui/components/app-icon-artwork.tsx";
import { Icon, iconToUrl } from "@ryu/ui/components/icon.tsx";
import { useSvglIndex } from "@ryu/ui/components/svgl.ts";
import { bundledIconArt } from "@ryu/ui/lib/app-icon-art.ts";
import bundledGlyphs from "@ryu/ui/lib/app-icon-glyphs.json" with {
	type: "json",
};
import { appIconMaterialSvg } from "@ryu/ui/lib/app-icon-material.ts";
import {
	APP_ICON_TILE_CARD,
	APP_ICON_TILE_CARD_GLYPH,
	APP_ICON_TILE_CARD_SURFACE,
	APP_ICON_TILE_HERO,
	APP_ICON_TILE_HERO_SURFACE,
} from "@ryu/ui/lib/app-icon-tile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties, ReactNode } from "react";
import { useCachedIconUrl } from "../icon-cache.ts";
import { resolveCardIcon } from "../icon-url.ts";
import type { CardDither, CardThemePreview } from "../types.ts";
import styles from "./app-icon.module.css";
import BrandOrCoverImage, { normalizeIconPadding } from "./brand-image.tsx";
import { normalizeDither } from "./dither.ts";

const bundledGlyphById = new Map(Object.entries(bundledGlyphs));

interface MonogramVariables extends CSSProperties {
	"--catalog-monogram-size": string;
}
interface BackgroundVariables extends CSSProperties {
	"--catalog-icon-background": string;
}
interface MaterialVariables extends CSSProperties {
	"--catalog-icon-material": string;
}
interface SwatchVariables extends CSSProperties {
	"--catalog-swatch-color": string;
}

export interface AppIconProps {
	/** Persist this icon's bytes under `<id>@<version>` (see
	 *  {@link iconCacheKey}), so it paints offline and is re-fetched only when the
	 *  app updates. Set it for anything INSTALLED; leave it unset while browsing a
	 *  catalog, where there is no installed version to key on. */
	cacheKey?: string | null;
	/** Extra classes for the square (sizing lives here: `size-10`, `size-5`, …). */
	className?: string;
	corners?: "default" | "compact" | "mention";
	/** Validated before use; an unpaintable spec falls through to `iconBackground`. */
	dither?: CardDither | null;
	/** Last-resort node when the item ships no art AND `seedId`/`name` is empty.
	 *  Prefer leaving this unset: the generative avatar is a better fallback than a
	 *  generic glyph, because it is at least specific to the item. */
	fallback?: ReactNode;
	/** Unframed project marks; monochrome black artwork turns white on dark surfaces. */
	iconAppearance?: "bare" | "monochrome";
	/** Flat CSS background, used only when `dither` is absent or invalid. */
	iconBackground?: string | null;
	/** Icon-primitive id (Iconify `prefix:name`, bare Hugeicons name, `svgl:<slug>`). */
	iconId?: string | null;
	/** The listing's declared inset for its raster mark (manifest `iconPadding`).
	 *  A raw wire string; validated here rather than by the caller, so a card and a
	 *  hero cannot disagree about what an unrecognized value means. */
	iconPadding?: string | null;
	/** Raster logo URL. */
	iconUrl?: string | null;
	/** Explicit dark-theme counterpart for bundled brand art. */
	iconUrlDark?: string | null;
	/** Display name — the seed of last resort, and the img alt. */
	name?: string | null;
	presentation?: AppIconPresentation;
	/** Stable seed for the generative tile — ALWAYS the item's unique id (the
	 *  plugin id, not its label), so the same app tiles identically everywhere. */
	seedId?: string | null;
	/** @deprecated Glyph tiles now always receive a deterministic material. */
	seedPlate?: boolean;
	/** Pixel size handed to the Icon primitive. Keep in step with `className`'s
	 *  box: an Icon needs an explicit box, unlike a class-sized Hugeicons element. */
	size?: number;
	/** A theme listing's own palette (manifest `contributes.themes[0].preview`).
	 *  When the item ships no art of its own, this is painted as the tile instead
	 *  of the generative avatar: for a theme the swatch IS the identity, and it is
	 *  the same icon the Appearance tab's preset picker shows. Real art (an
	 *  `iconId`/`iconUrl`/`fallback`) still wins over it — a theme that also ships
	 *  a logo shows the logo. */
	themePreview?: CardThemePreview | null;
	/** Card and hero share the same artwork and material; hero adds elevation. */
	variant?: "card" | "hero";
}

/**
 * The canonical app/plugin icon square.
 *
 * Renders the item's real art when it has any, and a deterministic generative tile
 * when it does not. Pass the manifest's presentational fields straight through —
 * `icon`, `iconUrl`, `iconDither`, `iconBackground` — plus the item's id as
 * `seedId`.
 */
export default function AppIcon({
	iconAppearance,
	cacheKey,
	className,
	corners = "default",
	presentation,
	dither,
	fallback,
	iconBackground,
	iconPadding,
	iconId,
	iconUrl,
	iconUrlDark,
	name,
	seedId,
	size = 20,
	themePreview,
	variant = "card",
}: AppIconProps) {
	const isHero = variant === "hero";
	const monogramStyle: MonogramVariables = {
		"--catalog-monogram-size": `${size}px`,
	};
	const bare = Boolean(iconAppearance);
	const safeDither = bare ? null : normalizeDither(dither);
	const svglIndex = useSvglIndex();
	const {
		iconId: resolvedIconId,
		iconUrl: resolvedIconUrl,
		iconUrlDark: resolvedIconUrlDark,
		brand: isBrandMark,
	} = resolveCardIcon({ icon: iconId, iconUrl, svglIndex });

	// Both icon lanes are cached: an Icon-primitive id resolves to a hosted SVG on
	// api.iconify.design just as surely as a raster logo resolves to a CDN URL, so
	// caching only the raster half would still leave most installed apps painting
	// blank while offline. The glyph is re-rendered through the SAME `Icon`
	// primitive either way (`iconToUrl` passes a `data:` URI through unchanged), so
	// the CSS-mask treatment — and with it `currentColor` — is preserved.
	//
	// Each lane gets its OWN key suffix. One app can carry a glyph and a light and a
	// dark mark at once, and a single shared key would have the three lanes
	// overwrite each other's bytes on every render — a cache that thrashes forever
	// instead of one that hits.
	const normalizedGlyph = resolvedIconId?.includes(":")
		? resolvedIconId
		: `hugeicons:${resolvedIconId}`;
	const bundledGlyph = bundledGlyphById.get(normalizedGlyph) ?? null;
	const glyphSource =
		bundledGlyph ??
		(resolvedIconId ? iconToUrl(resolvedIconId, { size }) : null);
	const cachedGlyph = useCachedIconUrl(
		glyphSource,
		// The size is part of the key because it is part of the URL: `iconToUrl`
		// asks Iconify for a glyph at an explicit width/height, so the 12px sidebar
		// row, the 20px card and the 28px hero request three different assets for
		// one app. Keyed without it they would each overwrite the other two on every
		// render and no surface would ever get a hit.
		cacheKey ? `${cacheKey}|glyph@${size}` : null
	);
	const cachedLight = useCachedIconUrl(
		bundledIconArt(resolvedIconUrl) ?? resolvedIconUrl ?? null,
		cacheKey ? `${cacheKey}|light` : null
	);
	const darkSource = iconUrlDark ?? resolvedIconUrlDark ?? null;
	const cachedDark = useCachedIconUrl(
		bundledIconArt(darkSource) ?? darkSource,
		cacheKey ? `${cacheKey}|dark` : null
	);

	// Supplied artwork wins. Art-less themes show their palette; other art-less
	// listings get a monogram on a stable material derived from the package id.
	const seed = seedId || name || "";
	const isPlaceholder = !(resolvedIconId || resolvedIconUrl || fallback);

	if (!bare && composerIconFor(seedId)) {
		return (
			<AppIconArtwork
				className={className}
				corners={corners}
				id={seedId}
				presentation={presentation}
				size={size * 2}
			/>
		);
	}

	let content: ReactNode;
	if (resolvedIconId) {
		content = (
			<Icon icon={bundledGlyph ?? cachedGlyph ?? resolvedIconId} size={size} />
		);
	} else if (resolvedIconUrl) {
		content = (
			<BrandOrCoverImage
				brand={isBrandMark === true || bare}
				className={
					iconAppearance === "monochrome"
						? isHero
							? "invert"
							: "dark:invert"
						: undefined
				}
				dark={cachedDark ?? darkSource}
				fallback={
					<span
						className={cn("font-semibold uppercase", styles.monogram)}
						style={monogramStyle}
					>
						{Array.from(name || seed || "R")[0]}
					</span>
				}
				light={cachedLight ?? resolvedIconUrl}
				padding={normalizeIconPadding(iconPadding)}
			/>
		);
	} else {
		content = fallback ?? null;
	}

	if (!bare && resolvedIconUrl && !resolvedIconId && iconPadding === "none") {
		return (
			<span
				className={cn(
					"relative flex shrink-0 items-center justify-center",
					corners === "compact" && "rounded-artwork-compact",
					corners === "mention" && "rounded-artwork-mention",
					appIconPresentationClasses(presentation),
					className
				)}
				data-app-icon="image"
			>
				{content}
			</span>
		);
	}

	const flatBackground: BackgroundVariables | undefined =
		!(bare || safeDither) && iconBackground
			? {
					"--catalog-icon-background": iconBackground,
				}
			: undefined;

	const materialInput = {
		seed: seed || "ryu",
		from: safeDither?.from,
		to: safeDither?.to,
	};
	const useMaterial =
		!bare &&
		(!iconBackground || !!safeDither) &&
		(!!resolvedIconId ||
			!resolvedIconUrl ||
			isBrandMark ||
			(normalizeIconPadding(iconPadding) !== null && iconPadding !== "none")) &&
		!(isPlaceholder && themePreview);
	const glyphColor = useMaterial ? "text-foreground" : APP_ICON_TILE_CARD_GLYPH;
	const lightMaterialStyle: MaterialVariables | undefined = useMaterial
		? {
				"--catalog-icon-material": `url("data:image/svg+xml,${encodeURIComponent(appIconMaterialSvg(materialInput))}")`,
			}
		: undefined;
	const darkMaterialStyle: MaterialVariables | undefined = useMaterial
		? {
				"--catalog-icon-material": `url("data:image/svg+xml,${encodeURIComponent(appIconMaterialSvg(materialInput, "dark"))}")`,
			}
		: undefined;
	const swatchBackground: SwatchVariables | undefined =
		isPlaceholder && themePreview
			? { "--catalog-swatch-color": themePreview.bg }
			: undefined;
	const swatchSurface: SwatchVariables | undefined =
		isPlaceholder && themePreview
			? { "--catalog-swatch-color": themePreview.surface }
			: undefined;
	const swatchPrimary: SwatchVariables | undefined =
		isPlaceholder && themePreview
			? { "--catalog-swatch-color": themePreview.primary }
			: undefined;

	return (
		<span
			className={cn(
				bare
					? "relative flex shrink-0 items-center justify-center"
					: isHero
						? APP_ICON_TILE_HERO
						: APP_ICON_TILE_CARD,
				corners === "compact" && "rounded-artwork-compact",
				corners === "mention" && "rounded-artwork-mention",
				!bare && styles.frame,
				flatBackground && styles.flatBackground,
				glyphColor,
				bare || useMaterial || isPlaceholder || safeDither || iconBackground
					? ""
					: isHero
						? APP_ICON_TILE_HERO_SURFACE
						: APP_ICON_TILE_CARD_SURFACE,
				appIconPresentationClasses(presentation),
				className
			)}
			data-app-icon={useMaterial ? "fallback" : "art"}
			style={flatBackground}
		>
			{useMaterial ? (
				<>
					<span
						aria-hidden="true"
						className={cn("absolute inset-0 dark:hidden", styles.material)}
						style={lightMaterialStyle}
					/>
					<span
						aria-hidden="true"
						className={cn(
							"absolute inset-0 hidden dark:block",
							styles.material
						)}
						style={darkMaterialStyle}
					/>
				</>
			) : null}
			{isPlaceholder ? (
				themePreview ? (
					// The theme's own palette as the tile: the same three stacked
					// bars (bg / surface / primary) the Appearance tab's preset
					// picker paints. Proportions match `PresetSwatch` (32×20 → the
					// surface bar is a quarter, the primary a fifth), so the card
					// and the picker agree about what a theme looks like.
					<span className="flex size-full flex-col overflow-hidden">
						<span
							className={cn("block flex-1", styles.swatch)}
							style={swatchBackground}
						/>
						<span
							className={cn("block h-[25%]", styles.swatch)}
							style={swatchSurface}
						/>
						<span
							className={cn("block h-[20%]", styles.swatch)}
							style={swatchPrimary}
						/>
					</span>
				) : (
					<span
						aria-hidden="true"
						className={cn(
							"relative font-semibold uppercase",
							styles.monogram,
							useMaterial && styles.inheritedGlyph
						)}
						style={monogramStyle}
					>
						{Array.from(name || seed || "R")[0]}
					</span>
				)
			) : (
				<span
					className={cn(
						"relative flex items-center justify-center",
						resolvedIconUrl && !resolvedIconId && "size-full",
						useMaterial && styles.inheritedGlyph
					)}
				>
					{content}
				</span>
			)}
		</span>
	);
}
