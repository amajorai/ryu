import {
	COMPANY_PROFILES,
	COMPANY_ROUTES,
	type CompanyProfileId,
} from "./data/company.ts";

/*
 * The footer's link data, kept free of JSX and of the docs-URL resolver so the
 * docs site (apps/fumadocs/src/components/site-footer.tsx) renders the same
 * columns. Each host resolves hrefs for itself:
 *
 * - `site`: a path on the marketing site (ryuhq.com);
 * - `docs`: a path on the docs site, `/docs` itself being the docs home;
 * - `external`: an absolute URL on another site.
 */

export type FooterLinkKind = "site" | "docs" | "external";

export interface FooterLink {
	/** Accessible name when the visible label alone is ambiguous ("X"). */
	readonly ariaLabel?: string;
	readonly href: string;
	/** Defaults to `site`. */
	readonly kind?: FooterLinkKind;
	readonly label: string;
}

export interface FooterColumn {
	readonly links: readonly FooterLink[];
	readonly title: string;
}

/** The docs home path; hosts map it to their docs root. */
export const FOOTER_DOCS_HOME = "/docs";

/** The homepage positioning line beside the columns. */
export const FOOTER_TAGLINE = "Run agents with the tools and rules they need.";

/*
 * Link columns follow the header's product taxonomy. Each href appears once;
 * legal links and Contact stay in the legal row. Products, Platform and Build
 * carry no early-access or coming-soon catalog products; those stay reachable
 * from /products. Some links are flag-gated (closed standalone services such as
 * Mail, unlaunched products such as Workflows): hosts filter unreleased and
 * closed products through footerColumnsFor. Platform ends with the standalone
 * services, then the self-hosted and overview pages.
 */
export const FOOTER_COLUMNS: readonly FooterColumn[] = [
	{
		title: "Products",
		links: [
			{ href: "/products/desktop", label: "Ryu Desktop" },
			{ href: "/bot", label: "Bot" },
			{ href: "/agent", label: "Agent" },
			{ href: "/marketplace", label: "Marketplace" },
			{ href: "/products/apps", label: "Apps" },
			{ href: "/for", label: "By role" },
			{ href: "/products", label: "All products" },
		],
	},
	{
		title: "Platform",
		links: [
			{ href: "/products/core", label: "Ryu Core" },
			{ href: "/products/gateway", label: "Ryu Gateway" },
			{ href: "/products/cloud", label: "Ryu Cloud" },
			{
				href: "/products/agents-as-a-service",
				label: "Agents as a Service",
			},
			{ href: "/products/red-team", label: "Red Teaming" },
			{ href: "/products/mail", label: "Ryu Mail" },
			{ href: "/platform#infra", label: "Self-hosted" },
			{ href: "/platform", label: "How it fits together" },
		],
	},
	{
		title: "Build",
		links: [
			{ href: "/products/agents", label: "Agents" },
			{ href: "/products/workflows", label: "Workflows" },
			{ href: "/products/skills", label: "Skills" },
			{ href: "/products/mcp", label: "MCP" },
			{ href: "/products/extensions", label: "Extensions" },
			{ href: "/products/sdk", label: "SDK" },
			{ href: "/products/cli", label: "CLI" },
			{
				href: "/docs/standalone/sdk/openapi",
				kind: "docs",
				label: "API reference",
			},
		],
	},
	{
		title: "Resources",
		links: [
			{ href: FOOTER_DOCS_HOME, kind: "docs", label: "Docs" },
			{ href: COMPANY_ROUTES.knowledgeBase, label: "Knowledge Base" },
			{ href: "/help", label: "Help Center" },
			{ href: "/guides", label: "Guides" },
			{ href: "/academy", label: "Academy" },
			{ href: "/changelog", label: "Changelog" },
			{ href: "/blog", label: "Blog" },
			{ href: "/compare", label: "Compare" },
			{ href: "/stories", label: "User stories" },
		],
	},
	{
		title: "Company",
		links: [
			{ href: COMPANY_ROUTES.about, label: "About" },
			{ href: COMPANY_ROUTES.manifesto, label: "Manifesto" },
			{ href: COMPANY_ROUTES.careers, label: "Careers" },
			{ href: COMPANY_ROUTES.press, label: "Press" },
			{ href: COMPANY_ROUTES.brandAssets, label: "Brand assets" },
			{ href: COMPANY_ROUTES.events, label: "Events" },
			{ href: "/enterprise", label: "Enterprise" },
			{ href: "/security", label: "Security" },
			{ href: "/partners", label: "Partners" },
		],
	},
	{
		title: "Programs",
		links: [
			{ href: "/startups", label: "Startups" },
			{ href: "/students", label: "Students" },
			{ href: "/creator", label: "Creators" },
			{ href: "/referrals", label: "Referrals" },
			{ href: "/perks", label: "Perks" },
			{ href: "/certifications", label: "Certifications" },
		],
	},
];

/** The lead band's calls to action; Download is the primary one. */
export const FOOTER_START_LINKS: readonly FooterLink[] = [
	{ href: "/download", label: "Download" },
	{ href: "/pricing", label: "Pricing" },
	{ href: "/subscriptions", label: "Bring your subscription" },
	{ href: "/login", label: "Sign in" },
];

/*
 * The official profiles the footer links, with each accessible name as a whole
 * literal so the i18n extractor picks it up. A profile absent here stays off
 * the footer: GitHub is linked by the build row with its star count, and
 * Product Hunt is listed only on /press and /contact.
 */
const FOOTER_PROFILE_ARIA_LABELS: Partial<Record<CompanyProfileId, string>> = {
	x: "Ryu on X",
};

/**
 * Community and official profiles. Discord goes through /discord, which mints
 * a per-visitor invite.
 */
export const FOOTER_COMMUNITY_LINKS: readonly FooterLink[] = [
	{ href: "/community", label: "Community" },
	{ ariaLabel: "Ryu on Discord", href: "/discord", label: "Discord" },
	...COMPANY_PROFILES.flatMap((profile): FooterLink[] => {
		const ariaLabel = FOOTER_PROFILE_ARIA_LABELS[profile.id];
		return ariaLabel
			? [
					{
						ariaLabel,
						href: profile.href,
						kind: "external",
						label: profile.label,
					},
				]
			: [];
	}),
];

/** The only place for legal links; cookie settings render after them. */
export const FOOTER_LEGAL_LINKS: readonly FooterLink[] = [
	{ href: "/privacy", label: "Privacy" },
	{ href: "/terms", label: "Terms" },
	{ href: "/dpa", label: "DPA" },
	{ href: "/subprocessors", label: "Subprocessors" },
	{ href: COMPANY_ROUTES.contact, label: "Contact" },
];

const PRODUCT_PAGE_HREF = /^\/products\/([^/?#]+)$/u;

/** The product slug a `/products/<slug>` link points at, if any. */
export function footerProductSlug(link: FooterLink): string | undefined {
	if ((link.kind ?? "site") !== "site") {
		return;
	}
	return PRODUCT_PAGE_HREF.exec(link.href)?.[1];
}

/**
 * `FOOTER_COLUMNS` without the product pages in `hiddenProductIds` (the host's
 * closed or unlaunched product slugs, the list the header hides). A column
 * left empty is dropped; the shared column data is never edited.
 */
export function footerColumnsFor(
	hiddenProductIds: readonly string[] = []
): FooterColumn[] {
	const hidden = new Set(hiddenProductIds);
	return FOOTER_COLUMNS.flatMap((column) => {
		const links = column.links.filter(
			(link) => !hidden.has(footerProductSlug(link) ?? "")
		);
		return links.length > 0 ? [{ ...column, links }] : [];
	});
}

/** Every footer link, in render order (columns, calls to action, community, legal). */
export function allFooterLinks(): FooterLink[] {
	return [
		...FOOTER_COLUMNS.flatMap((column) => column.links),
		...FOOTER_START_LINKS,
		...FOOTER_COMMUNITY_LINKS,
		...FOOTER_LEGAL_LINKS,
	];
}
