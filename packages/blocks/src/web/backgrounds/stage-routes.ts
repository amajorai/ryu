/**
 * Products whose page opens on a full-viewport stage hero over an animated
 * backdrop (`./hero-background.tsx`). The site header reads this to float over
 * the stage in the dark scheme, as it does over the landing hero. Kept free of
 * the backdrop code so the header does not import any effect.
 */
export const STAGE_PRODUCT_SLUGS = [
	"core",
	"gateway",
	"passport",
	"connect",
	"cloud",
	"box",
	"notify",
	"mail",
	"messaging",
	"sites",
	"agents-as-a-service",
	"hire",
	"compute",
	"share",
	"agents",
	"workflows",
	"skills",
	"mcp",
	"connections",
	"cli",
	"sdk",
	"bot",
	"agent",
	"os",
	"desktop",
	"island",
	"mobile",
	"chrome-extension",
	"devices",
	"marketplace",
	"extensions",
	"red-team",
] as const;

export type StageProductSlug = (typeof STAGE_PRODUCT_SLUGS)[number];

/**
 * Marketing pages that open on a stage hero, by path. Catalogue and browse
 * pages (pricing, the marketplace hub) keep a plain hero so their content
 * starts in the first viewport.
 */
export const STAGE_PAGES = {
	"/platform": "page-platform",
	"/enterprise": "page-enterprise",
	"/pro": "page-pro",
	"/teams": "page-teams",
	"/startups": "page-startups",
	"/students": "page-students",
	"/partners": "page-partners",
	"/security": "page-security",
	"/subscriptions": "page-subscriptions",
	"/download": "page-download",
	"/products": "page-products",
	"/for": "page-for",
	"/compare": "page-compare",
	"/creator": "page-creator",
	"/community": "page-community",
	"/perks": "page-perks",
	"/academy": "page-academy",
	"/contact": "page-contact",
	"/apps": "page-apps",
} as const;

export type StagePageId = (typeof STAGE_PAGES)[keyof typeof STAGE_PAGES];

/** Every backdrop key: a product slug or a marketing page id. */
export type StageKey = StageProductSlug | StagePageId;

const STAGE_SLUGS: ReadonlySet<string> = new Set(STAGE_PRODUCT_SLUGS);

/** Product pages served at the top level as well as under /products. */
const TOP_LEVEL_ALIASES: ReadonlySet<string> = new Set(["bot", "agent"]);

export function isStageProductSlug(slug: string): slug is StageProductSlug {
	return STAGE_SLUGS.has(slug);
}

/** Whether `pathname` is a page that opens on a stage hero. */
export function hasStageHero(pathname: string): boolean {
	const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
	if (Object.hasOwn(STAGE_PAGES, path)) {
		return true;
	}
	const match = /^\/(?:products\/)?([a-z0-9-]+)\/?$/.exec(pathname);
	if (!match?.[1]) {
		return false;
	}
	const slug = match[1];
	const isAlias = !pathname.startsWith("/products/");
	return isStageProductSlug(slug) && (!isAlias || TOP_LEVEL_ALIASES.has(slug));
}
