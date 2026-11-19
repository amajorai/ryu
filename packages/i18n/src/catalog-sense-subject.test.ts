import { describe, expect, test } from "bun:test";

// "Subject" is the email subject line (mail and outreach composers, sent-email
// tables, help-center tickets). The Vault binding target is an access-control
// "Principal", and the Tuition picker chooses a "School subject"; each sense
// has its own message so no locale reads one as another.

interface SubjectSenses {
	principal: string;
	school: string;
	subject: string;
}

const EXPECTED: Readonly<Record<string, SubjectSenses>> = {
	ar: { principal: "الجهة", school: "المادة", subject: "الموضوع" },
	de: { principal: "Subjekt", school: "Fach", subject: "Betreff" },
	ja: { principal: "対象", school: "科目", subject: "件名" },
};

const readCatalog = async (path: string) =>
	(await Bun.file(
		new URL(`../locales/${path}.json`, import.meta.url)
	).json()) as Record<string, string>;

describe('"Subject" reads as the email subject line', () => {
	test.each(
		Object.entries(EXPECTED)
	)("the root %s catalog keeps the three senses apart", async (locale, expected) => {
		const catalog = await readCatalog(locale);
		expect({
			principal: catalog.Principal,
			school: catalog["School subject"],
			subject: catalog.Subject,
		}).toEqual(expected);
	});

	test.each(
		Object.keys(EXPECTED)
	)("the %s mail, tuition and web subsets use their own sense", async (locale) => {
		const expected = EXPECTED[locale];
		const mail = await readCatalog(`apps/mail/${locale}`);
		const tuition = await readCatalog(`apps/tuition/${locale}`);
		const web = await readCatalog(`web/${locale}`);
		expect(mail.Subject).toBe(expected?.subject);
		expect(tuition["School subject"]).toBe(expected?.school);
		expect(web.Principal).toBe(expected?.principal);
	});
});
