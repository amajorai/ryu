import {
	BadgeCheck,
	BookOpen,
	GitCommitHorizontal,
	GraduationCap,
	LifeBuoy,
	Newspaper,
	Quote,
	Scale,
	Trophy,
	Users,
} from "lucide-react";

/* Resources power the marketing header's "Resources" menu: the non-product
 * destinations (docs, learning, updates, community). Pricing leads that menu
 * from `PLAN_LINKS` below; Marketplace lives in the Products menu. */

export type ResourceCategory = "Learn" | "Updates" | "Community";

/* Docs live in a separate Fumadocs app, not a route in this site. The base URL
 * is configurable via NEXT_PUBLIC_DOCS_URL (inlined by Next at build). Local
 * development can point it at :4000; production uses the canonical docs host. */
const configuredDocsUrl = process.env.NEXT_PUBLIC_DOCS_URL;

function resolveDocsUrl(): string {
	if (!configuredDocsUrl) {
		return process.env.NODE_ENV === "development"
			? "http://localhost:4000"
			: "https://docs.ryuhq.com";
	}

	try {
		const url = new URL(configuredDocsUrl);
		const isLoopback =
			url.hostname === "localhost" ||
			url.hostname === "127.0.0.1" ||
			url.hostname === "[::1]";
		if (isLoopback && url.pathname.replace(/\/$/, "") === "/docs") {
			return "http://localhost:4000";
		}
	} catch {
		// An invalid value is left to the browser so the existing configuration
		// contract remains visible to the caller instead of being silently hidden.
	}

	return configuredDocsUrl;
}

export const DOCS_URL = resolveDocsUrl();

export function docsHref(path: string): string {
	return `${DOCS_URL.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

/**
 * The shared "Read the docs" call to action. Docs live on their own site, so the
 * link is absolute and opens in a new tab on every page that carries it.
 */
export function readTheDocsCta(path = "/docs"): {
	external: true;
	href: string;
	label: string;
} {
	return { label: "Read the docs", href: docsHref(path), external: true };
}

/**
 * The booking link behind every "book a demo" / "free consultation" CTA.
 *
 * It lives here as ONE constant because it used to be a `const DEMO_HREF`
 * copy-pasted into eight blocks plus two data files, so changing the Cal
 * handle meant a ten-file sweep and any file missed kept pointing at a dead
 * link. Import this instead of re-declaring it.
 */
export const DEMO_HREF = "https://cal.com/amajor/ryu-demo";

/** Public markdown playbook that lets another agent set up Ryu for the user. */
export const SETUP_RYU_HREF = "/setup-ryu.md";
export const SETUP_RYU_LABEL = "Set up Ryu for me";
/**
 * Where "Join the Discord" links go. There is no public invite: the page mints
 * a personal, single-use invite for the signed-in account (and bounces
 * signed-out visitors to login first), so the server cannot be joined from a
 * scraped or reshared link.
 */
export const DISCORD_JOIN_PATH = "/discord";

/**
 * The "Plans" group that leads the Resources menu on desktop and the Resources
 * sheet on mobile: what Ryu costs and how to give it to someone.
 */
export const PLAN_LINKS: readonly { href: string; label: string }[] = [
	{ label: "Pricing", href: "/pricing" },
	{ label: "Gift Ryu", href: "/gifts" },
];

export interface Resource {
	category: ResourceCategory;
	description: string;
	external?: boolean;
	href: string;
	Icon: typeof BookOpen;
	label: string;
}

export const resources: Resource[] = [
	/* ============================== LEARN =========================== */
	{
		category: "Learn",
		label: "Docs",
		description: "Guides, references, and how-tos for the whole platform.",
		href: DOCS_URL,
		external: true,
		Icon: BookOpen,
	},
	{
		category: "Learn",
		label: "Academy",
		description: "Role-based paths, focused lessons, and knowledge checks.",
		href: "/academy",
		Icon: GraduationCap,
	},
	{
		category: "Learn",
		label: "Certifications",
		description: "Prepare, take an exam, and earn a verifiable credential.",
		href: "/certifications",
		Icon: BadgeCheck,
	},
	{
		category: "Learn",
		label: "Help Center",
		description: "Answers, troubleshooting, and integration guides.",
		href: "/help",
		Icon: LifeBuoy,
	},

	/* ============================= UPDATES ========================== */
	{
		category: "Updates",
		label: "Blog",
		description: "Product updates, deep dives, and engineering notes.",
		href: "/blog",
		Icon: Newspaper,
	},
	{
		category: "Updates",
		label: "Changelog",
		description: "Everything we ship, release by release.",
		href: "/changelog",
		Icon: GitCommitHorizontal,
	},
	{
		category: "Updates",
		label: "Stories",
		description: "How people use Ryu, in their own words. Share yours.",
		href: "/stories",
		Icon: Quote,
	},

	/* ============================ COMMUNITY ========================= */
	{
		category: "Community",
		label: "Challenges",
		description:
			"Build, share, and compete in community challenges and events.",
		href: "/challenges",
		Icon: Trophy,
	},
	{
		category: "Community",
		label: "Compare",
		description: "See how Ryu stacks up against the alternatives.",
		href: "/compare",
		Icon: Scale,
	},
	{
		category: "Community",
		label: "Stats",
		description: "Community activity, protection, and savings at a glance.",
		href: "/community",
		Icon: Users,
	},
];

export const resourceCategories: ResourceCategory[] = [
	"Learn",
	"Updates",
	"Community",
];

export function resourcesByCategory(category: ResourceCategory): Resource[] {
	return resources.filter((r) => r.category === category);
}
