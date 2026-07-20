import {
	BookOpen,
	Cpu,
	GitCommitHorizontal,
	KeyRound,
	LifeBuoy,
	MessageCircle,
	Newspaper,
	Quote,
	Scale,
	Store,
	Tag,
} from "lucide-react";

/* Resources power the marketing header's "Resources" mega-menu. They are the
 * non-product, non-solution destinations (docs, blog, changelog, marketplace,
 * pricing, help, community) that used to live only in the footer. Grouped into
 * a few categories so the dropdown mirrors Products and Solutions. */

export type ResourceCategory = "Learn" | "Explore" | "Support";

/* Docs live in a separate Fumadocs app, not a route in this site. The base URL
 * is configurable via NEXT_PUBLIC_DOCS_URL (inlined by Next at build): the local
 * dev server on :4000, or https://docs.ryuhq.com in prod. */
export const DOCS_URL =
	process.env.NEXT_PUBLIC_DOCS_URL ?? "http://localhost:4000";

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
		label: "Blog",
		description: "Product updates, deep dives, and engineering notes.",
		href: "/blog",
		Icon: Newspaper,
	},
	{
		category: "Learn",
		label: "Changelog",
		description: "Everything we ship, release by release.",
		href: "/changelog",
		Icon: GitCommitHorizontal,
	},

	/* ============================= EXPLORE ========================== */
	{
		category: "Explore",
		label: "Customize",
		description: "Browse and install agents, skills, tools, and apps.",
		href: "/marketplace",
		Icon: Store,
	},
	{
		category: "Explore",
		label: "Stories",
		description: "How people use Ryu, in their own words. Share yours.",
		href: "/stories",
		Icon: Quote,
	},
	{
		category: "Explore",
		label: "Compare",
		description: "See how Ryu stacks up against the alternatives.",
		href: "/compare",
		Icon: Scale,
	},
	{
		category: "Explore",
		label: "Pricing",
		description: "Plans for individuals, teams, and enterprises.",
		href: "/pricing",
		Icon: Tag,
	},
	{
		category: "Explore",
		label: "Engines",
		description: "Every model runtime Ryu can run, local to cloud.",
		href: "/engines",
		Icon: Cpu,
	},
	{
		category: "Explore",
		label: "Bring your subscription",
		description: "Route Claude Code and Codex on the plan you already pay for.",
		href: "/subscriptions",
		Icon: KeyRound,
	},

	/* ============================= SUPPORT ========================== */
	{
		category: "Support",
		label: "Help Center",
		description: "Answers, troubleshooting, and integration guides.",
		href: "/help",
		Icon: LifeBuoy,
	},
	{
		category: "Support",
		label: "Discord",
		description: "Join the community and talk to the team.",
		href: "https://discord.gg/46FkCKCMba",
		external: true,
		Icon: MessageCircle,
	},
];

export const resourceCategories: ResourceCategory[] = [
	"Learn",
	"Explore",
	"Support",
];

export function resourcesByCategory(category: ResourceCategory): Resource[] {
	return resources.filter((r) => r.category === category);
}
