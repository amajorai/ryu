import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	BACKERS,
	COMPANY,
	COMPANY_EMAILS,
	COMPANY_FACTS,
	COMPANY_PROFILES,
	COMPANY_ROUTES,
	companyFacts,
	EVENTS,
	eventsInSection,
	hasEvents,
	hasOpenRoles,
	OPEN_ROLES,
	OPEN_SOURCE_REPOS,
	type OpenRole,
	type RyuEvent,
} from "./company.ts";

// Each company fact is checked against the file that already publishes it, so
// this module can never state something the site does not.
const repoRoot = new URL("../../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repoRoot), "utf8");

const STRUCTURED_DATA = read("apps/web/src/lib/structured-data.ts");
const SITE_METADATA = read("apps/web/src/utils/metadata-site.ts");
const ABOUT = read("apps/web/content/pages/about.mdx");

test("the company identity matches the Organization JSON-LD", () => {
	expect(STRUCTURED_DATA).toContain(`name: "${COMPANY.legalName}"`);
	expect(STRUCTURED_DATA).toContain(`url: "${COMPANY.url}"`);
	expect(STRUCTURED_DATA).toContain(`addressCountry: "${COMPANY.countryCode}"`);
	expect(ABOUT).toContain(`${COMPANY.legalName} in ${COMPANY.country}`);
	expect(SITE_METADATA).toContain(`"${COMPANY.site}"`);
});

test("registration facts match the footer, whether literal or read from COMPANY", () => {
	const footer = read("packages/blocks/src/web/footer.tsx");
	for (const [key, value] of [
		["uen", COMPANY.uen],
		["foundingDate", COMPANY.foundingDate],
	] as const) {
		const stated = footer.includes(value) || footer.includes(`COMPANY.${key}`);
		expect([key, stated]).toEqual([key, true]);
	}
	expect(COMPANY_FACTS).toContainEqual({ label: "UEN", value: COMPANY.uen });
	expect(COMPANY_FACTS).toContainEqual({
		label: "Founded",
		value: "Apr 12, 2026",
	});
});

test("the founding date reads in the requested language", () => {
	const founded = (locale: string) =>
		companyFacts(locale).find((fact) => fact.label === "Founded")?.value;
	expect(founded("de")).toBe("12. Apr. 2026");
	expect(founded("ja")).toBe("2026年4月12日");
	expect(founded("en")).toBe("Apr 12, 2026");
});

test("profiles are exactly the official profiles", () => {
	expect(SITE_METADATA).toContain(`github: "${COMPANY_PROFILES[0]?.href}"`);
	expect(STRUCTURED_DATA).toContain("siteConfig.links.github");
	for (const profile of COMPANY_PROFILES.slice(1)) {
		expect(STRUCTURED_DATA).toContain(`"${profile.href}"`);
	}
	expect(COMPANY_PROFILES.map((profile) => profile.id)).toEqual([
		"github",
		"x",
		"producthunt",
	]);
	expect(
		COMPANY_PROFILES.some((profile) => /discord/i.test(profile.href))
	).toBe(false);
});

test("emails are the public addresses, and press goes to the general inbox", () => {
	expect(STRUCTURED_DATA).toContain(`"${COMPANY_EMAILS.general}"`);
	expect(STRUCTURED_DATA).toContain(`"${COMPANY_EMAILS.security}"`);
	expect(read("apps/web/content/pages/privacy.mdx")).toContain(
		COMPANY_EMAILS.privacy
	);
	// The contact page's channels live in its content module; the press route
	// lists this address as a mailto channel.
	const contact = read("apps/web/src/components/contact/contact-content.ts");
	expect(contact).toContain("href: mailto(COMPANY_EMAILS.press)");
	expect(contact).toMatch(/press/i);
	expect(COMPANY_EMAILS.press).toBe(COMPANY_EMAILS.general);
	const published = Object.values(COMPANY_EMAILS);
	expect(published).not.toContain("legal@amajor.ai");
	expect(published).not.toContain("conduct@ryuhq.com");
});

test("open-source repos and licences are the ones the about page states", () => {
	for (const repo of OPEN_SOURCE_REPOS) {
		expect(ABOUT).toContain(repo.href);
		for (const license of repo.licenses) {
			expect([repo.name, license, ABOUT.includes(license)]).toEqual([
				repo.name,
				license,
				true,
			]);
		}
	}
});

test("backers match the Backed by block and their logos exist", () => {
	const backedBy = read("packages/blocks/src/web/backed-by.tsx");
	for (const backer of BACKERS) {
		expect(backedBy).toContain(backer.href);
		expect(backedBy).toContain(backer.logo);
		expect(backedBy).toContain(backer.name);
		expect(existsSync(new URL(`apps/web/public${backer.logo}`, repoRoot))).toBe(
			true
		);
	}
});

test("company routes are site paths; existing ones resolve", () => {
	for (const [key, href] of Object.entries(COMPANY_ROUTES)) {
		expect([key, href.startsWith("/")]).toEqual([key, true]);
	}
	expect(
		existsSync(new URL("apps/web/content/pages/manifesto.mdx", repoRoot))
	).toBe(true);
	expect(
		existsSync(new URL("apps/web/src/app/contact/page.tsx", repoRoot))
	).toBe(true);
	expect(COMPANY_ROUTES.brandAssets).toBe(
		`${COMPANY_ROUTES.press}#brand-assets`
	);
});

const ROLE: OpenRole = {
	id: "fixture-engineer",
	title: "Fixture Engineer",
	team: "Engineering",
	location: "Singapore",
	type: "Full-time",
	href: "mailto:hello@ryuhq.com",
};

test("open roles are editor-managed and the predicate follows the list", () => {
	expect(hasOpenRoles()).toBe(OPEN_ROLES.length > 0);
	expect(hasOpenRoles([])).toBe(false);
	expect(hasOpenRoles([ROLE])).toBe(true);
	const ids = OPEN_ROLES.map((role) => role.id);
	expect(new Set(ids).size).toBe(ids.length);
	for (const role of OPEN_ROLES) {
		expect([role.id, /^(?:https:\/\/|mailto:)/.test(role.href)]).toEqual([
			role.id,
			true,
		]);
	}
});

const EVENT_FIXTURES: RyuEvent[] = [
	{
		id: "a",
		title: "Workshop",
		date: "2026-11-20",
		section: "upcoming",
		format: "online",
		level: "Beginner",
		href: "https://example.com/a",
	},
	{
		id: "b",
		title: "Recording",
		date: "2026-09-01",
		section: "on-demand",
		format: "online",
		href: "https://example.com/b",
	},
];

test("events are editor-managed and grouped by their assigned section", () => {
	expect(hasEvents()).toBe(EVENTS.length > 0);
	expect(hasEvents([])).toBe(false);
	expect(hasEvents(EVENT_FIXTURES)).toBe(true);
	expect(eventsInSection("upcoming", EVENT_FIXTURES).map((e) => e.id)).toEqual([
		"a",
	]);
	expect(eventsInSection("conference", EVENT_FIXTURES)).toEqual([]);
	for (const event of EVENTS) {
		expect([event.id, /^\d{4}-\d{2}-\d{2}$/.test(event.date)]).toEqual([
			event.id,
			true,
		]);
	}
});

test("event levels are the Academy levels", () => {
	const academy = read("apps/web/src/lib/academy.ts");
	const declared = academy.match(/export type AcademyLevel = ([^;]+);/)?.[1];
	const levels = [...(declared ?? "").matchAll(/"([^"]+)"/g)]
		.map((match) => match[1])
		.sort();
	const eventLevels: NonNullable<RyuEvent["level"]>[] = [
		"Advanced",
		"Beginner",
		"Intermediate",
	];
	expect(levels).toEqual(eventLevels);
});
