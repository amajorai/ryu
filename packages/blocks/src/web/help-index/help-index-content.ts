import { COMPANY_ROUTES } from "../data/company.ts";
import { DISCORD_JOIN_PATH, DOCS_URL } from "../data/resources.tsx";

// Copy for the /help routing hub (apps/web/src/app/help/(index)/page.tsx).
// Every sentence is reused from a page that already publishes it, noted per
// line; counts are computed from the articles, so nothing here states a number.

/** The section that lists each help category with its article count. */
export const HELP_TOPICS_SECTION = {
	id: "help-topics",
	title: "Browse by topic",
} as const;

/**
 * One line per known help category. Source: `getCategoryDescription` in
 * apps/web/src/app/help/category/[category]/page.tsx. A category without a
 * line here shows its name and count only.
 */
export const HELP_CATEGORY_DESCRIPTIONS: Readonly<Record<string, string>> = {
	"chat bots": "Connect Telegram and Discord bots to your agents.",
	sync: "Keep chats and Spaces in step across your devices.",
};

export function helpCategoryDescription(category: string): string | undefined {
	return HELP_CATEGORY_DESCRIPTIONS[category.toLowerCase()];
}

/** Where a category card links: the existing per-category route. */
export function helpCategoryHref(category: string): string {
	return `/help/category/${encodeURIComponent(category)}`;
}

export type HelpEscalationStepId =
	| "docs"
	| "knowledge-base"
	| "community"
	| "contact";

export interface HelpEscalationStep {
	readonly href: string;
	readonly id: HelpEscalationStepId;
	readonly linkLabel: string;
	/**
	 * Plain anchor instead of a client route: the docs live on another host, and
	 * /discord mints a personal invite, so neither should be prefetched.
	 */
	readonly plainAnchor: boolean;
	/** One line on what the step is for, quoted from the page cited beside it. */
	readonly purpose: string;
	readonly title: string;
}

export const HELP_ESCALATION_SECTION = {
	id: "help-escalation",
	title: "Still need help?",
	subtitle: "Work down the list, from the reference to the team.",
} as const;

/** The escalation ladder, in the order a reader should try each step. */
export const HELP_ESCALATION_STEPS: readonly HelpEscalationStep[] = [
	{
		id: "docs",
		title: "Docs",
		// KB_COLLECTIONS "Docs" in apps/web/src/components/knowledge-base/kb-content.ts.
		purpose:
			"Install Ryu, configure its surfaces and services, and build on its APIs.",
		href: DOCS_URL,
		linkLabel: "Read the docs",
		plainAnchor: true,
	},
	{
		id: "knowledge-base",
		title: "Knowledge Base",
		// KB_HERO subtitle and primary CTA in kb-content.ts.
		purpose:
			"Help articles, guides, Academy courses and docs topics, searchable in one place.",
		href: COMPANY_ROUTES.knowledgeBase,
		linkLabel: "Search the knowledge base",
		plainAnchor: false,
	},
	{
		id: "community",
		title: "Community",
		// The Discord channel on /contact (apps/web/src/app/contact).
		purpose: "Chat with the team and other users. Requires a Ryu account.",
		href: DISCORD_JOIN_PATH,
		linkLabel: "Join the Discord",
		plainAnchor: true,
	},
	{
		id: "contact",
		title: "Contact",
		// The /contact hero subtitle; "Contact us" is the KB closing CTA label.
		purpose: "Get help with setup, discuss a deployment, or report a problem.",
		href: COMPANY_ROUTES.contact,
		linkLabel: "Contact us",
		plainAnchor: false,
	},
];
