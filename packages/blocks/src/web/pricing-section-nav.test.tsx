import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
	PRICING_SECTION_IDS,
	type PricingSectionKey,
	PricingSectionNav,
} from "./pricing-section-nav.tsx";

const ALL: PricingSectionKey[] = [
	"compare",
	"credits",
	"fees",
	"products",
	"questions",
];

test("renders one labelled anchor per section, in the order given", () => {
	const html = renderToStaticMarkup(<PricingSectionNav sections={ALL} />);
	expect(html).toContain('<nav aria-label="On this page"');
	const links = [...html.matchAll(/href="#([^"]+)"[^>]*>([^<]+)</gu)].map(
		(match) => [match[1], match[2]]
	);
	expect(links).toEqual([
		["compare-plans", "Compare plans"],
		["what-credits-buy", "Credits"],
		["fees", "Fees"],
		["standalone-pricing", "Products"],
		["pricing-faq", "Questions"],
	]);
});

test("lists only the sections on screen and nothing when there are none", () => {
	const some = renderToStaticMarkup(
		<PricingSectionNav sections={["fees", "questions"]} />
	);
	expect(some.match(/<a /gu)).toHaveLength(2);
	expect(some).not.toContain("#compare-plans");
	expect(renderToStaticMarkup(<PricingSectionNav sections={[]} />)).toBe("");
});

test("every link targets the id its section component sets", () => {
	const source = (file: string) =>
		readFileSync(new URL(file, import.meta.url), "utf8");
	const owners: Record<Exclude<PricingSectionKey, "questions">, string> = {
		compare: "./pricing-comparison-table.tsx",
		credits: "./pricing-credit-estimates-section.tsx",
		fees: "./pricing-fees-section.tsx",
		products: "./standalone-product-pricing.tsx",
	};
	for (const [key, file] of Object.entries(owners)) {
		// SAFETY: `owners` is keyed by PricingSectionKey; Object.entries widens it to string.
		const id = PRICING_SECTION_IDS[key as PricingSectionKey];
		expect([key, source(file).includes(`id="${id}"`)]).toEqual([key, true]);
	}
});
