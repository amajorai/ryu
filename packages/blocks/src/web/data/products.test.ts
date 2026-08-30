import { expect, test } from "bun:test";
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
