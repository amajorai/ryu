import { describe, expect, test } from "bun:test";
import { buttonVariants } from "./button-variants.ts";

describe("password-reveal button appearance", () => {
	test("pins itself to the input's logical end, matching its pe-10 padding", () => {
		const classes = buttonVariants({
			appearance: "password-reveal",
			size: "sm",
			variant: "ghost",
		}).split(/\s+/);
		for (const required of ["absolute", "inset-y-0", "end-0", "h-full"]) {
			expect(classes).toContain(required);
		}
		expect(classes).not.toContain("h-8");
		expect(classes.filter((name) => /^(left|right)-/.test(name))).toEqual([]);
	});
});
