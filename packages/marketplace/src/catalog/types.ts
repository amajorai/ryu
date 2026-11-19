// packages/marketplace/src/catalog/types.ts
//
// Structural item + hook-state types for the shared catalog sections. These
// declare ONLY the fields the moved components actually read — pass-through /
// unread fields on the desktop hooks (e.g. AppCatalogItem.info) are intentionally
// omitted so a surface's real hook result stays structurally assignable without
// this package importing anything from apps/desktop. Desktop passes its concrete
// hook results (which carry a superset of these fields); web passes an adapter
// that fabricates exactly these fields from its federated catalog data.

// ---------------------------------------------------------------------------
// Apps (plugins) realm
// ---------------------------------------------------------------------------

export type { DesignSystemEvidence } from "./design-system-scorecard.ts";

/**
 * The `?source=` value that browses every marketplace at once — the store's
 * default view. Mirrors Core's `PLUGIN_ALL_SOURCES_ID`.
 *
 * It is a VIEW, not a registered source: it never appears in the `sources` list
 * the server returns, it cannot be the node's active-source preference, and Core
 * resolves it to a list of real sources at both the browse and detail seams. It
 * lives in this module — the wire contract both hosts already import — rather than
 * beside the component that renders it, so the desktop and web hooks can default to
 * it without pulling the section's component tree into their bundle.
 */
export const ALL_PLUGIN_SOURCES_ID = "all";

/** The live federated view across every registered Skill marketplace. */
export const ALL_SKILL_SOURCES_ID = "all";
export type {
	AddMarketplaceParams,
	AppsCatalogState,
	CatalogChannel,
	MarketplaceMoveDirection,
	PluginCatalogDetail,
	PluginCatalogSource,
} from "./types-apps.ts";
export type {
	CatalogExtensionSummary,
	CatalogImplementationSummary,
	CatalogSurfaceSupport,
	CompatibilityVerdict,
	HostFloors,
	Surface,
	UnmetRequirement,
} from "./types-compatibility.ts";
export {
	blockingUnmet,
	evaluateCompatibility,
} from "./types-compatibility.ts";
export type {
	AppCatalogItem,
	CatalogEntry,
} from "./types-entry.ts";
export type { CatalogLayer } from "./types-layers.ts";
export {
	catalogLayerBadges,
	catalogLayerLabel,
} from "./types-layers.ts";
export type {
	CatalogApiSurface,
	CatalogContribution,
	CatalogMcpServer,
	CatalogModelProvider,
	CatalogPermissions,
	CatalogRoute,
	CatalogSidecar,
	CatalogVersion,
	VersionSnapshot,
} from "./types-listing-parts.ts";
export type {
	AaStats,
	DeviceInfo,
	FitVerdict,
	InstalledModelEntry,
	LlmFitEstimate,
	ModelCard,
	ModelCatalogSource,
	ModelCatalogState,
	ModelCategory,
	ModelDetail,
	ModelFile,
	ModelFormat,
	ModelSort,
} from "./types-models.ts";
export { MODEL_CATEGORY_OPTIONS } from "./types-models.ts";
export type {
	CardDither,
	CardThemePreview,
	CatalogBanner,
	CatalogBannerGradient,
	CatalogDeprecation,
	CatalogRemixSource,
} from "./types-presentation.ts";
export type {
	SkillAudit,
	SkillCard,
	SkillCatalogSource,
	SkillDetail,
	SkillDetailMetadata,
	SkillFile,
	SkillSort,
	SkillsCatalogState,
} from "./types-skills.ts";
