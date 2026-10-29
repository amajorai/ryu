import { describe, expect, test } from "bun:test";
import { products } from "../../../data/products.tsx";
import { solutions } from "../../../data/solutions.ts";
import { ENTERPRISE_CONTROLS } from "../../../enterprise-landing.tsx";
import { CARD_HEIGHT, CARD_WIDTH } from "./card.ts";
import { BENTO_GROUP_LOADERS, type BentoGroupId } from "./loaders.ts";

/*
 * Every bento card on the site has a drawing, and every drawing belongs to a
 * card: a renamed card title fails here instead of silently losing its figure.
 */

const PLATFORM_LAYERS = ["core", "gateway", "cloud"];

const expected = new Map<string, string[]>([
	...products
		.filter((product) => product.bento.items.length > 0)
		.map((product): [string, string[]] => [
			product.slug,
			product.bento.items.map((item) => item.title),
		]),
	...solutions.map((solution): [string, string[]] => [
		`for/${solution.slug}`,
		solution.useCases.map((item) => item.title),
	]),
	["enterprise", ENTERPRISE_CONTROLS.map((item) => item.title)],
	[
		"platform",
		products
			.filter((product) => PLATFORM_LAYERS.includes(product.slug))
			.map((product) => product.name),
	],
]);

describe("bento card drawings", () => {
	test("every page with a bento grid has a group", () => {
		for (const group of expected.keys()) {
			expect(Object.keys(BENTO_GROUP_LOADERS)).toContain(group);
		}
	});

	for (const group of Object.keys(BENTO_GROUP_LOADERS) as BentoGroupId[]) {
		test(group, async () => {
			const { drawings } = await BENTO_GROUP_LOADERS[group]();
			const titles = Object.keys(drawings);
			expect(titles.length).toBeGreaterThan(0);
			const want = expected.get(group);
			if (want) {
				expect([...titles].sort()).toEqual([...want].sort());
			}
			for (const drawing of Object.values(drawings)) {
				expect(drawing.width).toBe(CARD_WIDTH);
				expect(drawing.height).toBe(CARD_HEIGHT);
				expect(drawing.nodes.length).toBeGreaterThan(8);
			}
		});
	}
});
