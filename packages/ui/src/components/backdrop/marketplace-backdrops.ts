import {
	type MarketplaceWallpaperSelection,
	parseMarketplaceWallpaperSelection,
} from "@ryuhq/protocol/marketplace-wallpaper";
import { z } from "zod";
import {
	BACKDROPS,
	type BackdropCategory,
	type BackdropDefinition,
	backdropById,
} from "./definitions.ts";
import {
	type BackdropParams,
	defaultBackdropParams,
	resolveBackdropParams,
} from "./params.ts";
import {
	PATTERNCRAFT_WALLPAPERS,
	type PatternCraftCategory,
	type PatternCraftWallpaper,
} from "./patterncraft-wallpapers.generated.ts";

const PATTERNCRAFT_PLUGIN_ID = "com.ryu.patterncraft";
const PATTERNCRAFT_BACKDROP_ID = "patterncraft-css";
const MARKETPLACE_DEFAULTS_PLUGIN_ID = "com.ryu.marketplace-defaults";
const PATTERNCRAFT_CATEGORY = {
	decorative: "Decorative",
	effects: "Effects",
	geometric: "Geometric",
	gradients: "Gradients",
} satisfies Record<PatternCraftCategory, BackdropCategory>;
const PATTERNCRAFT_BY_ID = new Map(
	PATTERNCRAFT_WALLPAPERS.map((wallpaper) => [wallpaper.id, wallpaper])
);

/** Marketplace selections carry raw JSON; local controls carry resolved values. */
type MarketplaceBackdropParams =
	| MarketplaceWallpaperSelection["params"]
	| BackdropParams;

/** The safe, serializable part of a Marketplace wallpaper contribution. */
export interface MarketplaceBackdropSource {
	attribution?: string;
	attributionUrl?: string;
	backdropId: string;
	description?: string;
	id: string;
	label: string;
	params: MarketplaceBackdropParams;
	plugin: string;
}

/** The shipped source list always includes visible provenance. */
export interface AttributedMarketplaceBackdropSource
	extends MarketplaceBackdropSource {
	attribution: string;
	attributionUrl: string;
}

/** A wallpaper resolved to one of the host's built-in backdrop renderers. */
export interface RenderableBackdrop extends BackdropDefinition {
	attribution?: string;
	attributionUrl?: string;
	/** Stable host renderer id, separate from the namespaced Marketplace id. */
	backdropId: string;
	/** Initial parameter overrides supplied by the Marketplace source. */
	initialParams: BackdropParams;
	origin: "builtin" | "marketplace";
}

/** The portable choice saved by Spaces and profile banner surfaces. */
export type { MarketplaceWallpaperSelection };

export const BUNDLED_MARKETPLACE_BACKGROUNDS: readonly AttributedMarketplaceBackdropSource[] =
	[
		{
			attribution: "Remocn",
			attributionUrl:
				"https://remocn.dev/docs/shaders/getting-started/introduction",
			backdropId: "shader-mesh-gradient",
			description:
				"Soft colour fields drift across a procedural mesh gradient.",
			id: `${MARKETPLACE_DEFAULTS_PLUGIN_ID}:mesh-gradient`,
			label: "Mesh Gradient",
			params: {},
			plugin: MARKETPLACE_DEFAULTS_PLUGIN_ID,
		},
		{
			attribution: "Remocn",
			attributionUrl: "https://www.remocn.dev/docs/environment/dynamic-grid",
			backdropId: "shader-dot-grid",
			description: "A fine shader grid drifts in a seamless loop.",
			id: `${MARKETPLACE_DEFAULTS_PLUGIN_ID}:dynamic-grid`,
			label: "Dynamic Grid",
			params: {},
			plugin: MARKETPLACE_DEFAULTS_PLUGIN_ID,
		},
		...PATTERNCRAFT_WALLPAPERS.map((wallpaper) => ({
			attribution: "PatternCraft",
			attributionUrl: "https://patterncraft.fun/",
			backdropId: PATTERNCRAFT_BACKDROP_ID,
			description:
				wallpaper.description ??
				`${PATTERNCRAFT_CATEGORY[wallpaper.category]} CSS wallpaper from PatternCraft.`,
			id: `${PATTERNCRAFT_PLUGIN_ID}:${wallpaper.slug}`,
			label: wallpaper.label,
			params: { patternId: wallpaper.id },
			plugin: PATTERNCRAFT_PLUGIN_ID,
		})),
	];

/** Validate the stable Marketplace id format before persisting a selection. */
export const marketplaceBackdropIdSchema = z
	.string()
	.max(225)
	.refine((value) => {
		const separator = value.lastIndexOf(":");
		if (separator <= 0) {
			return false;
		}
		const plugin = value.slice(0, separator);
		const localId = value.slice(separator + 1);
		const validPlugin = plugin.startsWith("@")
			? /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(plugin)
			: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plugin);
		return (
			validPlugin &&
			/^[a-z0-9][a-z0-9._-]{0,95}$/.test(localId) &&
			value === `${plugin}:${localId}`
		);
	});
export function isMarketplaceBackdropId(
	value: Parameters<typeof marketplaceBackdropIdSchema.safeParse>[0]
): value is string {
	return marketplaceBackdropIdSchema.safeParse(value).success;
}

function patternCraftDefinition(
	wallpaper: PatternCraftWallpaper
): BackdropDefinition {
	return {
		animated: wallpaper.style.animation !== undefined,
		category: PATTERNCRAFT_CATEGORY[wallpaper.category],
		description:
			wallpaper.description ??
			`${PATTERNCRAFT_CATEGORY[wallpaper.category]} CSS wallpaper from PatternCraft.`,
		id: PATTERNCRAFT_BACKDROP_ID,
		label: wallpaper.label,
		params: [],
		render: { kind: "css", style: wallpaper.style },
	};
}

function marketplaceDefinition(
	backdropId: string,
	params: MarketplaceBackdropParams
): BackdropDefinition | undefined {
	if (backdropId !== PATTERNCRAFT_BACKDROP_ID) {
		return backdropById(backdropId);
	}
	const patternId = z.string().safeParse(params.patternId);
	if (!patternId.success) {
		return undefined;
	}
	const wallpaper = PATTERNCRAFT_BY_ID.get(patternId.data);
	return wallpaper ? patternCraftDefinition(wallpaper) : undefined;
}

/** Can this Marketplace source resolve through a host-owned renderer? */
export function isSupportedMarketplaceBackdrop(
	source: MarketplaceBackdropSource
): boolean {
	return marketplaceDefinition(source.backdropId, source.params) !== undefined;
}

function renderMarketplaceBackdrop(
	source: MarketplaceBackdropSource,
	params: MarketplaceBackdropParams = source.params
): RenderableBackdrop | undefined {
	const definition = marketplaceDefinition(source.backdropId, params);
	if (!definition) {
		return undefined;
	}
	const resolvedParams =
		source.backdropId === PATTERNCRAFT_BACKDROP_ID
			? { patternId: z.string().parse(params.patternId) }
			: resolveBackdropParams(definition.params, params);
	return {
		...definition,
		attribution: source.attribution,
		attributionUrl: source.attributionUrl,
		backdropId: source.backdropId,
		description: source.description ?? definition.description,
		id: source.id,
		initialParams: resolvedParams,
		label: source.label,
		origin: "marketplace",
	};
}

const BUNDLED_RENDERABLE_BACKGROUNDS = BUNDLED_MARKETPLACE_BACKGROUNDS.flatMap(
	(source) => {
		const wallpaper = renderMarketplaceBackdrop(source);
		return wallpaper ? [wallpaper] : [];
	}
);

/** The portable wallpaper catalog available on every Ryu surface. */
export function getBundledMarketplaceBackdrops(): RenderableBackdrop[] {
	return [...BUNDLED_RENDERABLE_BACKGROUNDS];
}

/** Resolve contributions using the same allowlisted host adapters as the picker. */
export function getMarketplaceBackdrops(
	backgrounds: readonly MarketplaceBackdropSource[] = BUNDLED_MARKETPLACE_BACKGROUNDS
): RenderableBackdrop[] {
	if (backgrounds === BUNDLED_MARKETPLACE_BACKGROUNDS) {
		return getBundledMarketplaceBackdrops();
	}
	const resolved: RenderableBackdrop[] = [];
	for (const source of backgrounds) {
		const wallpaper = renderMarketplaceBackdrop(source);
		if (wallpaper) {
			resolved.push(wallpaper);
		}
	}
	return resolved;
}

/** Convert a resolved catalog entry into the small value surfaces persist. */
export function toMarketplaceWallpaperSelection(
	wallpaper: RenderableBackdrop
): MarketplaceWallpaperSelection {
	const selection = {
		backdropId: wallpaper.backdropId,
		id: wallpaper.id,
		params: Object.fromEntries(
			Object.entries(wallpaper.initialParams).map(([key, value]) => [
				key,
				Array.isArray(value) ? [...value] : value,
			])
		),
	};
	const parsed = parseMarketplaceWallpaperSelection(selection);
	if (!parsed) {
		throw new Error("Wallpaper parameters are not safe to save.");
	}
	return parsed;
}

/** Resolve persisted or server-provided selection data at the renderer boundary. */
export function resolveMarketplaceWallpaperSelection(
	value: Parameters<typeof parseMarketplaceWallpaperSelection>[0],
	backgrounds: readonly MarketplaceBackdropSource[] = BUNDLED_MARKETPLACE_BACKGROUNDS
): RenderableBackdrop | undefined {
	const selection = parseMarketplaceWallpaperSelection(value);
	if (!selection) {
		return undefined;
	}
	const known = backgrounds.find(
		(source) =>
			source.id === selection.id && source.backdropId === selection.backdropId
	);
	const separator = selection.id.lastIndexOf(":");
	const source: MarketplaceBackdropSource = known
		? { ...known, params: selection.params }
		: {
				backdropId: selection.backdropId,
				id: selection.id,
				label: selection.id.slice(separator + 1),
				params: selection.params,
				plugin: selection.id.slice(0, separator),
			};
	return renderMarketplaceBackdrop(source, selection.params);
}

/** Existing registry backdrops plus the Marketplace catalog. */
export function getAvailableBackdrops(
	backgrounds: readonly MarketplaceBackdropSource[] = BUNDLED_MARKETPLACE_BACKGROUNDS
): RenderableBackdrop[] {
	const builtIns: RenderableBackdrop[] = BACKDROPS.map((definition) => ({
		...definition,
		backdropId: definition.id,
		initialParams: defaultBackdropParams(definition.params),
		origin: "builtin",
	}));
	return [...builtIns, ...getMarketplaceBackdrops(backgrounds)];
}

export function backdropByAvailableId(
	id: string,
	backgrounds: readonly MarketplaceBackdropSource[] = BUNDLED_MARKETPLACE_BACKGROUNDS
): RenderableBackdrop | undefined {
	const builtIn = backdropById(id);
	if (builtIn) {
		return {
			...builtIn,
			backdropId: builtIn.id,
			initialParams: defaultBackdropParams(builtIn.params),
			origin: "builtin",
		};
	}
	return getMarketplaceBackdrops(backgrounds).find(
		(background) => background.id === id
	);
}
