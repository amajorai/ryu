import { describe, expect, test } from "bun:test";
import {
	isRevealable,
	valueTypeChoices,
	valueTypeOf,
	withValueType,
} from "./vault-value-type.ts";

describe("vault value types", () => {
	test("defaults rows without a type to secret", () => {
		expect(valueTypeOf({})).toBe("secret");
		expect(valueTypeOf({ valueType: "bogus" })).toBe("secret");
		expect(valueTypeOf({ valueType: "sealed" })).toBe("sealed");
		expect(valueTypeOf({ valueType: "config" })).toBe("config");
	});

	test("never offers a way out of sealed", () => {
		expect(valueTypeChoices("sealed")).toEqual(["sealed"]);
		expect(valueTypeChoices("secret")).toEqual(["config", "secret", "sealed"]);
		expect(valueTypeChoices(null)).toEqual(["config", "secret", "sealed"]);
		expect(isRevealable("sealed")).toBe(false);
		expect(isRevealable("config")).toBe(true);
	});

	test("sends the type only when it changes", () => {
		expect(withValueType({ description: "d" }, "secret", "secret")).toEqual({
			description: "d",
		});
		const sealed: object = withValueType(
			{ description: "d" },
			"secret",
			"sealed"
		);
		expect(sealed).toEqual({ description: "d", valueType: "sealed" });
		const fresh: object = withValueType({}, null, "secret");
		expect(fresh).toEqual({ valueType: "secret" });
	});
});
