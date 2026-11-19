import { describe, expect, test } from "bun:test";

// "Tickets" is the support queue (the help-center inbox heading, web support
// pages). The kitchen order rail has its own `kitchen.orderTickets` message,
// so the plural reads like the singular "Ticket" and never as order slips.

interface TicketSenses {
	ticket: string;
	tickets: string;
}

const EXPECTED: Readonly<Record<string, TicketSenses>> = {
	ar: { ticket: "تذكرة", tickets: "التذاكر" },
	de: { ticket: "Ticket", tickets: "Tickets" },
	ja: { ticket: "チケット", tickets: "チケット" },
};

const readCatalog = async (path: string) =>
	(await Bun.file(
		new URL(`../locales/${path}.json`, import.meta.url)
	).json()) as Record<string, string>;

describe('"Tickets" reads as the support queue', () => {
	test.each(
		Object.entries(EXPECTED)
	)("the root %s catalog matches the singular ticket", async (locale, expected) => {
		const catalog = await readCatalog(locale);
		expect({ ticket: catalog.Ticket, tickets: catalog.Tickets }).toEqual(
			expected
		);
	});

	test.each(
		Object.keys(EXPECTED)
	)("the %s help-center subset uses the support sense", async (locale) => {
		const helpCenter = await readCatalog(`apps/help-center/${locale}`);
		expect(helpCenter.Tickets).toBe(EXPECTED[locale]?.tickets);
	});
});
