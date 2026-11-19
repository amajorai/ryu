// packages/marketplace/src/catalog/types-layers.ts
//
// Swappable capability layers a listing serves, and their card badges.
// Split out of `types.ts`, which re-exports everything here so existing import
// paths keep working.

/** Public, non-executable summary of one swappable capability a listing serves. */
export interface CatalogLayer {
	capability: string;
	selectable?: boolean;
	target?: string | null;
	title?: string | null;
	toolkit?: boolean;
	verbs?: string[];
}

// The label builders take the caller's `tl` and return catalogued sentences
// ("{title} layer", "{title} toolkit", "External"); they live in
// `layer-labels.ts` and are re-exported here so the facade names stay stable.
export { catalogLayerBadges, catalogLayerLabel } from "./layer-labels.ts";
