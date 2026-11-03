import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import type {
	ProductArchetypeId,
	ProductSectionKey,
	ProfileRequirement,
} from "./profile-types.ts";

/**
 * Which layout each product page uses below its (unchanged) stage hero. The
 * record is keyed by every stage slug, so the compiler rejects an unmapped one.
 */
export const PRODUCT_ARCHETYPE_BY_SLUG: Readonly<
	Record<StageProductSlug, ProductArchetypeId>
> = {
	core: "infrastructure",
	gateway: "infrastructure",
	cloud: "infrastructure",
	"red-team": "infrastructure",
	"agents-as-a-service": "infrastructure",
	passport: "agent-api",
	connect: "agent-api",
	box: "agent-api",
	notify: "agent-api",
	mail: "agent-api",
	messaging: "agent-api",
	sites: "agent-api",
	sdk: "builder",
	cli: "builder",
	mcp: "builder",
	skills: "builder",
	extensions: "builder",
	agents: "builder",
	workflows: "builder",
	bot: "workspace",
	agent: "workspace",
	desktop: "workspace",
	os: "workspace",
	"chrome-extension": "workspace",
	marketplace: "catalog",
	connections: "catalog",
	compute: "preview",
	share: "preview",
	island: "preview",
	mobile: "preview",
	devices: "preview",
	hire: "preview",
};

export const PRODUCT_ARCHETYPES: readonly ProductArchetypeId[] = [
	"infrastructure",
	"agent-api",
	"builder",
	"workspace",
	"catalog",
	"preview",
];

/** True when the archetype draws its product figure directly under the hero. */
export function figureFollowsHero(archetype: ProductArchetypeId): boolean {
	return ARCHETYPE_SECTION_ORDER[archetype][1] === "figure";
}

/** The archetype for a slug; anything unmapped renders as infrastructure. */
export function getProductArchetype(slug: string): ProductArchetypeId {
	return (
		(PRODUCT_ARCHETYPE_BY_SLUG as Readonly<Record<string, ProductArchetypeId>>)[
			slug
		] ?? "infrastructure"
	);
}

/**
 * Section order per archetype. The layout renders each key's slot in this order
 * and skips a slot that is null for the product, so a key listed here is a
 * place, not a promise. The opening is the archetype's own: a datasheet and a
 * workspace show the product figure first, a builder page opens on its code
 * band, an agent API on code beside its interfaces, a catalog on the listing
 * kinds and a preview on where it stands; the figure then follows. Tails vary
 * too (builders reach the docs before the FAQ; previews end on the FAQ). Slot rules (owned by ./layouts/section-slots.tsx):
 * - `how-it-works` is null in agent-api and builder when the profile has a quickstart;
 * - `explorer` absorbs `features` (workspace never lists both);
 * - `integrations` renders the explainer's worksWith as cards, in place of `works-with`;
 * - `pricing` renders only for a standalone product with published pricing.
 */
export const ARCHETYPE_SECTION_ORDER: Readonly<
	Record<ProductArchetypeId, readonly ProductSectionKey[]>
> = {
	infrastructure: [
		"hero",
		"figure",
		"statement",
		"at-a-glance",
		"architecture",
		"features",
		"code",
		"how-it-works",
		"capabilities",
		"guardrail",
		"comparison",
		"security",
		"built-for",
		"pricing",
		"faq",
		"works-with",
		"compare",
		"related",
		"docs",
		"cta",
	],
	"agent-api": [
		"hero",
		"code",
		"interfaces",
		"figure",
		"statement",
		"api",
		"at-a-glance",
		"pricing",
		"limits",
		"features",
		"guardrail",
		"quickstart",
		"how-it-works",
		"capabilities",
		"built-for",
		"faq",
		"integrations",
		"compare",
		"related",
		"docs",
		"cta",
	],
	builder: [
		"hero",
		"code",
		"quickstart",
		"figure",
		"statement",
		"features",
		"how-it-works",
		"capabilities",
		"at-a-glance",
		"built-for",
		"pricing",
		"integrations",
		"docs",
		"faq",
		"compare",
		"related",
		"cta",
	],
	workspace: [
		"hero",
		"figure",
		"explorer",
		"statement",
		"availability",
		"how-it-works",
		"capabilities",
		"at-a-glance",
		"built-for",
		"pricing",
		"faq",
		"integrations",
		"compare",
		"related",
		"docs",
		"cta",
	],
	catalog: [
		"hero",
		"catalog",
		"figure",
		"statement",
		"at-a-glance",
		"features",
		"how-it-works",
		"capabilities",
		"built-for",
		"pricing",
		"faq",
		"works-with",
		"compare",
		"related",
		"docs",
		"cta",
	],
	preview: [
		"hero",
		"status-board",
		"figure",
		"statement",
		"availability",
		"at-a-glance",
		"features",
		"how-it-works",
		"capabilities",
		"built-for",
		"pricing",
		"works-with",
		"related",
		"docs",
		"faq",
		"cta",
	],
};

/**
 * Authored catalog and explainer content must stay visible on every page: each
 * archetype lists at least one key of every group (a group's keys are
 * alternatives that render the same authored data).
 */
export const AUTHORED_SECTION_GROUPS: readonly (readonly ProductSectionKey[])[] =
	[
		["hero"],
		["figure"],
		["statement"],
		["features", "explorer"],
		["how-it-works"],
		["capabilities"],
		["built-for"],
		["pricing"],
		["faq"],
		["works-with", "integrations"],
		["cta"],
	];

/** Pairs rendered side by side in one two-column band, in DOM order. */
export const ARCHETYPE_SIDE_BY_SIDE: Readonly<
	Partial<
		Record<ProductArchetypeId, readonly [ProductSectionKey, ProductSectionKey]>
	>
> = {
	"agent-api": ["code", "interfaces"],
};

/** The band that wraps a side-by-side pair. */
export const PRODUCT_SIDE_BY_SIDE_TEST_ID = "product-side-by-side";

const testId = (id: string) => `data-testid="${id}"`;

/**
 * The HTML marker each section renders, as a full attribute string, so order
 * tests can `indexOf` it. New sections use `data-testid="product-<key>"`
 * (explorer: `product-feature-explorer`). Hero and figure carry a value that
 * varies by layout, so their marker stops at `=`.
 */
export const PRODUCT_SECTION_MARKERS: Readonly<
	Record<ProductSectionKey, (slug: string) => string>
> = {
	hero: () => "data-product-hero-layout=",
	figure: () => "data-product-figure=",
	statement: () => testId("product-statement"),
	"at-a-glance": () => testId("product-at-a-glance"),
	architecture: () => testId("product-architecture"),
	code: () => testId("product-code"),
	interfaces: () => testId("product-interfaces"),
	api: () => testId("product-api"),
	limits: () => testId("product-limits"),
	quickstart: () => testId("product-quickstart"),
	features: () => testId("product-features"),
	explorer: () => testId("product-feature-explorer"),
	"how-it-works": () => testId("product-how-it-works"),
	capabilities: () => testId("product-capabilities"),
	comparison: () => testId("product-comparison"),
	guardrail: () => testId("product-guardrail"),
	security: () => testId("product-security"),
	availability: () => testId("product-availability"),
	catalog: () => testId("product-catalog"),
	"status-board": () => testId("product-status-board"),
	"built-for": () => testId("product-built-for"),
	pricing: (slug) => testId(`standalone-pricing-${slug}`),
	faq: () => testId("faq"),
	"works-with": () => testId("product-works-with"),
	integrations: () => testId("product-integrations"),
	compare: () => testId("product-compare"),
	related: () => testId("product-related"),
	docs: () => testId("product-docs"),
	cta: () => testId("product-cta"),
};

/**
 * Sections that get an anchor and an entry in the in-page sub-nav. `id` is the
 * element id the layout gives the section (unique per page); the label is the
 * sub-nav text. Hero, figure and the closing CTA never appear in the sub-nav.
 */
export const PRODUCT_SECTION_NAV: Readonly<
	Partial<
		Record<ProductSectionKey, { readonly id: string; readonly label: string }>
	>
> = {
	statement: { id: "overview", label: "Overview" },
	"at-a-glance": { id: "at-a-glance", label: "At a glance" },
	architecture: { id: "architecture", label: "Architecture" },
	code: { id: "code", label: "Code" },
	interfaces: { id: "interfaces", label: "Interfaces" },
	api: { id: "api", label: "API" },
	limits: { id: "limits", label: "Limits" },
	quickstart: { id: "quickstart", label: "Quickstart" },
	features: { id: "features", label: "Features" },
	explorer: { id: "features", label: "Features" },
	"how-it-works": { id: "how-it-works", label: "How it works" },
	capabilities: { id: "capabilities", label: "Capabilities" },
	comparison: { id: "comparison", label: "Compare options" },
	guardrail: { id: "guardrails", label: "Guardrails" },
	security: { id: "security", label: "Security" },
	availability: { id: "availability", label: "Availability" },
	catalog: { id: "catalog", label: "Catalog" },
	"status-board": { id: "status", label: "Status" },
	pricing: { id: "pricing", label: "Pricing" },
	faq: { id: "faq", label: "FAQ" },
	docs: { id: "docs", label: "Docs" },
};

/**
 * What each archetype needs from a profile (see `profileGaps` in ./profiles.ts):
 * - `facts`: at least two profile facts;
 * - `docs`: only when the product has a "Read the docs" CTA;
 * - `limits` and `openapi` are added per slug below, not per archetype.
 */
export const ARCHETYPE_REQUIREMENTS: Readonly<
	Record<ProductArchetypeId, readonly ProfileRequirement[]>
> = {
	infrastructure: ["facts", "architecture", "code-or-comparison", "docs"],
	"agent-api": ["facts", "code", "interfaces", "docs"],
	builder: ["facts", "code", "quickstart", "docs"],
	workspace: ["facts", "availability"],
	catalog: ["facts", "catalog"],
	preview: ["facts", "status"],
};

/** Agent APIs with published rates in `PUBLISHED_PRICING`: their pages need a limits table. */
export const LIMITS_REQUIRED_SLUGS: readonly StageProductSlug[] = [
	"box",
	"notify",
	"passport",
	"mail",
	"connect",
];

/** Agent APIs with an OpenAPI document in apps/web/public/openapi/<slug>.json. */
export const OPENAPI_REQUIRED_SLUGS: readonly StageProductSlug[] = [
	"passport",
	"connect",
	"box",
	"notify",
	"mail",
	"messaging",
	"sites",
];

/** The full requirement list for one slug, in a stable order. */
export function requirementsForSlug(
	slug: string,
	{ hasDocsCta }: { hasDocsCta: boolean }
): ProfileRequirement[] {
	const base = ARCHETYPE_REQUIREMENTS[getProductArchetype(slug)].filter(
		(requirement) => requirement !== "docs" || hasDocsCta
	);
	const extra: ProfileRequirement[] = [];
	if ((LIMITS_REQUIRED_SLUGS as readonly string[]).includes(slug)) {
		extra.push("limits");
	}
	if ((OPENAPI_REQUIRED_SLUGS as readonly string[]).includes(slug)) {
		extra.push("openapi");
	}
	return [...base, ...extra];
}
