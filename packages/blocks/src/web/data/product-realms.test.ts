import { expect, test } from "bun:test";
import { PRODUCT_REALMS } from "./product-realms.ts";

test("the product realm keeps the public product names and destinations together", () => {
	expect(PRODUCT_REALMS.map((realm) => realm.id)).toEqual([
		"os",
		"bot",
		"console",
		"gateway",
		"box",
		"mail",
		"notify",
		"hire",
	]);
	expect(PRODUCT_REALMS.map((realm) => realm.label)).toEqual([
		"Ryu OS",
		"Ryu Bot",
		"Ryu Console",
		"Ryu Gateway",
		"Ryu Box",
		"Ryu Mail",
		"Ryu Notify",
		"Ryu Hire",
	]);
	for (const realm of PRODUCT_REALMS) {
		expect(realm.href.startsWith("/")).toBe(true);
		expect(realm.description.length).toBeGreaterThan(20);
	}
});
