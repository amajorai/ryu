import { expect, test } from "bun:test";
import {
	getProductLandingStyle,
	PRODUCT_LANDING_STYLES,
} from "../product-landing-layouts.tsx";
import { getProduct, products } from "./products.tsx";

test("the standalone product set includes the direct service APIs", () => {
	expect(
		products
			.filter((product) => product.standalone)
			.map((product) => product.slug)
	).toEqual(["gateway", "box", "notify", "mail"]);
	expect(getProduct("notify")).toMatchObject({
		name: "Ryu Notify",
		standalone: true,
	});
	expect(getProduct("mail")).toMatchObject({
		name: "Ryu Mail",
		standalone: true,
	});
});

test("every public product has a distinct landing composition", () => {
	expect(
		products.every((product) => product.slug in PRODUCT_LANDING_STYLES)
	).toBe(true);

	const compositions = products.map((product) => {
		const style = getProductLandingStyle(product.slug);
		return `${style.hero}/${style.bento}`;
	});

	expect(new Set(compositions).size).toBe(products.length);
});
