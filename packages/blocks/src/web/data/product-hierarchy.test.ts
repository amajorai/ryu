import { expect, test } from "bun:test";
import { PRODUCT_HIERARCHY } from "./product-hierarchy.ts";

test("the hero product hierarchy keeps the platform and surface distinctions together", () => {
	expect(PRODUCT_HIERARCHY.map((realm) => realm.id)).toEqual([
		"deploy",
		"sdk",
		"core",
		"gateway",
		"bot",
		"console",
		"apps",
	]);
	expect(
		PRODUCT_HIERARCHY.map((realm) => `${realm.label} = ${realm.verb}`)
	).toEqual([
		"Deploy = Cloud",
		"SDK = Integrate",
		"Core = Run",
		"Gateway = Secure",
		"Bot = Chat",
		"Agent = Configure",
		"Apps = Use",
	]);
	expect(
		PRODUCT_HIERARCHY.slice(1, 4).every((realm) => realm.group === "Platform")
	).toBe(true);
	expect(
		PRODUCT_HIERARCHY.slice(4).every(
			(realm) => realm.group === "Interfaces / surfaces"
		)
	).toBe(true);
});
