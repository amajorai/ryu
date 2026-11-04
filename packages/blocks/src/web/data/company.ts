import { formatIsoDate } from "../page-sections/format-date.ts";

// Company facts for the company and resource pages (about, press, careers,
// events), the footer and the mobile nav. Every value is already public in the
// repo; company.test.ts checks each one against the file that publishes it.
// Never add a person, title, address, customer, job or event that is not real.

/**
 * The operating company and the product. Sources: the footer's copyright
 * microdata (packages/blocks/src/web/footer.tsx) and the Organization JSON-LD
 * (apps/web/src/lib/structured-data.ts). No street address is public.
 */
export const COMPANY = {
	legalName: "A Major Pte. Ltd.",
	shortName: "A Major",
	uen: "202616096G",
	foundingDate: "2026-04-12",
	country: "Singapore",
	countryCode: "SG",
	url: "https://amajor.ai",
	productName: "Ryu",
	site: "https://ryuhq.com",
} as const;

/**
 * Public addresses. Press goes to the general inbox; /contact links press to
 * /press, which shows this address as the media contact. Licensing and conduct addresses are
 * deliberately absent: /contact explains they are scoped to those reports.
 */
export const COMPANY_EMAILS = {
	general: "hello@ryuhq.com",
	press: "hello@ryuhq.com",
	security: "security@amajor.ai",
	privacy: "privacy@ryuhq.com",
} as const;

export type CompanyProfileId = "github" | "x" | "producthunt";

export interface CompanyProfile {
	readonly href: string;
	readonly id: CompanyProfileId;
	readonly label: string;
}

/**
 * Official profiles (`OFFICIAL_PROFILES` in apps/web/src/lib/structured-data.ts).
 * Discord is absent on purpose: /discord mints per-visitor invites. The footer
 * already links GitHub through its build info, so it leaves that entry out.
 */
export const COMPANY_PROFILES: readonly CompanyProfile[] = [
	{ id: "github", label: "GitHub", href: "https://github.com/amajorai" },
	{ id: "x", label: "X", href: "https://x.com/ryuhq" },
	{
		id: "producthunt",
		label: "Product Hunt",
		href: "https://www.producthunt.com/products/ryu",
	},
];

export interface OpenSourceRepo {
	readonly description: string;
	readonly href: string;
	readonly licenses: readonly string[];
	readonly name: string;
}

/**
 * Public repositories with a licence stated in this repo (apps/web/content/pages/about.mdx).
 * Add another repo only with its licence read from a file here.
 */
export const OPEN_SOURCE_REPOS: readonly OpenSourceRepo[] = [
	{
		name: "amajorai/ryu",
		href: "https://github.com/amajorai/ryu",
		description: "Ryu Core and Gateway, open source so you can self-host them.",
		licenses: ["Apache-2.0", "AGPL-3.0-or-later"],
	},
];

export interface Backer {
	readonly href: string;
	/** Path under apps/web/public. */
	readonly logo: string;
	readonly name: string;
}

/** Source: packages/blocks/src/web/backed-by.tsx. */
export const BACKERS: readonly Backer[] = [
	{ name: "BLOCK71", href: "https://block71.co", logo: "/block71.png" },
];

/** Company and resource routes, for the footer, header and mobile nav. */
export const COMPANY_ROUTES = {
	about: "/about",
	manifesto: "/manifesto",
	press: "/press",
	brandAssets: "/press#brand-assets",
	careers: "/careers",
	events: "/events",
	knowledgeBase: "/knowledge-base",
	contact: "/contact",
} as const;

/** One registration fact as a fact-sheet row (label, value, href). */
export interface CompanyFact {
	readonly external?: boolean;
	readonly href?: string;
	readonly label: string;
	readonly value: string;
}

/** The company's country in `locale` ("Singapore", "シンガポール"); English when Intl cannot name it. */
export function companyCountryName(
	locale: string | null | undefined = "en"
): string {
	try {
		return (
			new Intl.DisplayNames([locale || "en"], { type: "region" }).of(
				COMPANY.countryCode
			) ?? COMPANY.country
		);
	} catch {
		return COMPANY.country;
	}
}

/** The company's registration facts, with the country and founding date in `locale`. */
export function companyFacts(
	locale: string | null | undefined = "en"
): readonly CompanyFact[] {
	return [
		{ label: "Company", value: COMPANY.legalName },
		{ label: "Based in", value: companyCountryName(locale) },
		{ label: "UEN", value: COMPANY.uen },
		{ label: "Founded", value: formatIsoDate(COMPANY.foundingDate, locale) },
		{ label: "Website", value: "amajor.ai", href: COMPANY.url, external: true },
	];
}

/** The English registration facts (prerendered pages without a request). */
export const COMPANY_FACTS: readonly CompanyFact[] = companyFacts();

/* Open roles ----------------------------------------------------------- */

export type OpenRoleType =
	| "Full-time"
	| "Part-time"
	| "Contract"
	| "Internship";

export interface OpenRole {
	/** Where to apply: a posting URL or a mailto. */
	readonly href: string;
	readonly id: string;
	readonly location: string;
	readonly team: string;
	readonly title: string;
	readonly type: OpenRoleType;
}

/**
 * Editor-managed. Empty until a real role is open; /careers then shows an empty
 * state and stays noindex. Add a role only with a live posting to link.
 */
export const OPEN_ROLES: readonly OpenRole[] = [];

export function hasOpenRoles(roles: readonly OpenRole[] = OPEN_ROLES): boolean {
	return roles.length > 0;
}

/* Events --------------------------------------------------------------- */

/** Matches `AcademyLevel` in apps/web/src/lib/academy.ts. */
export type EventLevel = "Beginner" | "Intermediate" | "Advanced";

/** Set by the editor, never computed from the date (prerenders stay deterministic). */
export type EventSection = "upcoming" | "on-demand" | "conference";

export type EventFormat = "online" | "in-person";

export interface RyuEvent {
	/** ISO date, "2026-11-20". */
	readonly date: string;
	readonly format: EventFormat;
	/** Registration or recording URL. */
	readonly href: string;
	readonly id: string;
	readonly level?: EventLevel;
	readonly location?: string;
	readonly section: EventSection;
	readonly title: string;
}

/**
 * Editor-managed. Empty until a real event is scheduled or recorded; /events
 * then shows honest empty states and stays noindex.
 */
export const EVENTS: readonly RyuEvent[] = [];

export function hasEvents(events: readonly RyuEvent[] = EVENTS): boolean {
	return events.length > 0;
}

/** Events in one editor-assigned section, in the editor's order. */
export function eventsInSection(
	section: EventSection,
	events: readonly RyuEvent[] = EVENTS
): RyuEvent[] {
	return events.filter((event) => event.section === section);
}
