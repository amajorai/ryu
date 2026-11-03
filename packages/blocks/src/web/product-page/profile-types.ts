import type { StageProductSlug } from "../backgrounds/stage-routes.ts";

/**
 * Product pages share one hero and figure, then lay out their body by archetype
 * (see ./archetypes.ts). Per-product material beyond the catalog entry lives in
 * a sidecar `ProductProfile` keyed by slug (./profiles.ts), so the catalog files
 * and their word budgets stay as they are.
 */
export type ProductArchetypeId =
	| "infrastructure"
	| "agent-api"
	| "builder"
	| "workspace"
	| "catalog"
	| "preview";

/**
 * Where a fact comes from: a repo-relative file and, when it is not a computed
 * value, a quote that appears in that file verbatim (whitespace normalised).
 * A computed price names `packages/blocks/src/web/data/standalone-pricing.ts`
 * with no quote; a quote is supporting evidence, never the displayed value.
 */
export interface ProductSource {
	readonly path: string;
	readonly quote?: string;
}

/** A source whose quote is required (code, commands). */
export interface ProductQuotedSource extends ProductSource {
	readonly quote: string;
}

/** One label/value row of a fact sheet. Base facts use this shape. */
export interface ProductFactRow {
	readonly external?: boolean;
	readonly href?: string;
	readonly label: string;
	readonly value: string;
}

/** A profile fact: always sourced. */
export interface ProductFact extends ProductFactRow {
	readonly source: ProductSource;
}

export type ProductCodeLanguage =
	| "bash"
	| "json"
	| "ts"
	| "tsx"
	| "python"
	| "http"
	| "yaml"
	| "toml";

/**
 * A real snippet. `source.quote` is one distinctive line: it must appear both in
 * the source file and in `code`, so the sample cannot drift from its origin.
 */
export interface ProductCodeSample {
	readonly code: string;
	readonly filename?: string;
	readonly id: string;
	readonly label: string;
	readonly language: ProductCodeLanguage;
	readonly source: ProductQuotedSource;
}

export interface ProductArchitectureNode {
	readonly detail: string;
	readonly label: string;
}

/** A left-to-right request or data flow of 3–6 nodes. */
export interface ProductArchitecture {
	readonly caption?: string;
	readonly nodes: readonly ProductArchitectureNode[];
	readonly source: ProductSource;
	readonly title: string;
}

export type ProductInterfaceKind =
	| "REST"
	| "MCP"
	| "SDK"
	| "CLI"
	| "Webhook"
	| "Desktop"
	| "OpenAI-compatible";

/** "not-published": the interface exists in the repo but is not released (say why in `note`). */
export type ProductInterfaceStatus = "available" | "not-published";

export interface ProductInterfaceRow {
	readonly href?: string;
	readonly kind: ProductInterfaceKind;
	readonly name: string;
	readonly note?: string;
	readonly source: ProductSource;
	/** Defaults to "available". */
	readonly status?: ProductInterfaceStatus;
	readonly summary: string;
}

export interface ProductLimitRow {
	readonly label: string;
	readonly note?: string;
	readonly source: ProductSource;
	readonly value: string;
}

export interface ProductLimits {
	readonly rows: readonly ProductLimitRow[];
	readonly title: string;
}

/** A step with a command must quote that command from its source. */
export type ProductQuickstartStep =
	| {
			readonly command?: undefined;
			readonly description: string;
			readonly source?: ProductSource;
			readonly title: string;
	  }
	| {
			readonly command: string;
			readonly description: string;
			readonly source: ProductQuotedSource;
			readonly title: string;
	  };

/**
 * `columns` are the compared options (at least two); every row has exactly one
 * value per column. `rowHeader` labels the first (row-label) column.
 */
export interface ProductComparison {
	readonly columns: readonly [string, string, ...string[]];
	readonly rowHeader?: string;
	readonly rows: readonly {
		readonly label: string;
		readonly values: readonly string[];
	}[];
	readonly source: ProductSource;
	readonly title: string;
}

export type ProductTerminalLineKind =
	| "command"
	| "output"
	| "allowed"
	| "denied";

export interface ProductTerminalLine {
	readonly kind: ProductTerminalLineKind;
	readonly text: string;
}

/** A terminal transcript of a control saying no (or yes), drawn from the docs. */
export interface ProductGuardrailDemo {
	readonly description: string;
	readonly lines: readonly ProductTerminalLine[];
	readonly source: ProductSource;
	readonly title: string;
}

export type ProductAvailabilityState =
	| "available"
	| "early-access"
	| "planned"
	| "not-planned";

export interface ProductAvailabilityRow {
	readonly note?: string;
	readonly platform: string;
	readonly source: ProductSource;
	readonly state: ProductAvailabilityState;
}

export interface ProductCatalogItem {
	readonly description: string;
	readonly href?: string;
	readonly source: ProductSource;
	readonly title: string;
}

export interface ProductCatalog {
	/**
	 * The caption under the item count (default "Listed below"). Set it when
	 * the grid shows a selection, so the count does not read as the total.
	 */
	readonly countLabel?: string;
	readonly items: readonly ProductCatalogItem[];
	readonly subtitle?: string;
	readonly title: string;
}

export interface ProductStatusItem {
	readonly source: ProductSource;
	readonly text: string;
}

/**
 * Preview products: what works today and what is planned. Planned items must
 * come from a docs page that calls them planned; the column reads
 * "Planned (not a commitment)".
 */
export interface ProductStatusBoard {
	readonly notPlanned?: readonly ProductStatusItem[];
	readonly planned: readonly ProductStatusItem[];
	readonly today: readonly ProductStatusItem[];
}

/** A docs page, by its docs-site path ("/docs/standalone/box"). */
export interface ProductDocLink {
	readonly description?: string;
	readonly label: string;
	readonly path: string;
}

export type ProductRelatedKind = "guide" | "help" | "blog" | "docs";

/**
 * Curated further reading. `href` is the site path for guide ("/guides/<slug>"),
 * help ("/help/<slug>") and blog ("/blog/<slug>"); for docs it is the docs-site
 * path ("/docs/…"), rendered through `docsHref`.
 */
export interface ProductRelatedLink {
	readonly href: string;
	readonly kind: ProductRelatedKind;
	readonly label: string;
}

/**
 * The service's published OpenAPI document (served from apps/web/public, e.g.
 * "/openapi/box.json") and, when a host is published, its API base URL.
 * `source` must contain the base URL's host.
 */
export interface ProductOpenApi {
	readonly baseUrl?: string;
	readonly href: string;
	readonly source: ProductSource;
}

/** Product-specific security points shown beside the /security links. */
export interface ProductSecurityPanel {
	readonly points: readonly ProductStatusItem[];
}

export interface ProductProfile {
	readonly architecture?: ProductArchitecture;
	readonly availability?: readonly ProductAvailabilityRow[];
	/** Heading over `availability`; defaults to "Where it runs". */
	readonly availabilityTitle?: string;
	readonly catalog?: ProductCatalog;
	readonly code?: readonly ProductCodeSample[];
	/** Slugs of `apps/web/src/data/comparisons/<slug>.json`, linked as /compare/<slug>. */
	readonly compareSlugs?: readonly string[];
	readonly comparison?: ProductComparison;
	readonly docs?: readonly ProductDocLink[];
	/** Product-specific facts; base facts (./base-facts.ts) are added automatically. */
	readonly facts: readonly ProductFact[];
	readonly guardrail?: ProductGuardrailDemo;
	readonly interfaces?: readonly ProductInterfaceRow[];
	readonly limits?: ProductLimits;
	readonly openapi?: ProductOpenApi;
	readonly quickstart?: readonly ProductQuickstartStep[];
	readonly related?: readonly ProductRelatedLink[];
	readonly security?: ProductSecurityPanel;
	readonly status?: ProductStatusBoard;
}

/** Every slot a product page body can render, in no particular order. */
export type ProductSectionKey =
	| "hero"
	| "figure"
	| "statement"
	| "at-a-glance"
	| "architecture"
	| "code"
	| "interfaces"
	| "api"
	| "limits"
	| "quickstart"
	| "features"
	| "explorer"
	| "how-it-works"
	| "capabilities"
	| "comparison"
	| "guardrail"
	| "security"
	| "availability"
	| "catalog"
	| "status-board"
	| "built-for"
	| "pricing"
	| "faq"
	| "works-with"
	| "integrations"
	| "compare"
	| "related"
	| "docs"
	| "cta";

/** What an archetype needs from a profile before its page reads complete. */
export type ProfileRequirement =
	| "facts"
	| "architecture"
	| "code"
	| "interfaces"
	| "limits"
	| "openapi"
	| "quickstart"
	| "availability"
	| "catalog"
	| "status"
	| "docs"
	| "code-or-comparison";

/** One profile data file: the archetype it fills, the slugs it owns, its entries. */
export interface ProductProfileFile {
	readonly archetype: ProductArchetypeId;
	readonly file: string;
	readonly profiles: Partial<Record<StageProductSlug, ProductProfile>>;
	readonly slugs: readonly StageProductSlug[];
}
