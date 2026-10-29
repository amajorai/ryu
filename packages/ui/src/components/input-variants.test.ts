import { describe, expect, test } from "bun:test";
import { cn } from "../lib/utils.ts";
import { inputVariants } from "./input.tsx";

describe("input leading adornment", () => {
	test("keeps ordinary inputs at their size padding", () => {
		const classes = cn(inputVariants({ size: "default" })).split(" ");
		expect(classes).toContain("px-3");
		expect(classes).not.toContain("pl-8");
		expect(classes).not.toContain("pl-9");
	});

	test("reserves compact icon space while retaining right padding", () => {
		const classes = cn(
			inputVariants({ size: "default", leadingAdornment: "compact" })
		).split(" ");
		expect(classes).toContain("px-3");
		expect(classes).toContain("pl-8");
	});

	test("reserves default icon space for large inputs", () => {
		const classes = cn(
			inputVariants({ size: "lg", leadingAdornment: "default" })
		).split(" ");
		expect(classes).toContain("px-4");
		expect(classes).toContain("pl-9");
	});

	test("title inputs retain their larger typography at desktop widths", () => {
		const classes = cn(
			inputVariants({ variant: "title", size: "default" })
		).split(" ");
		expect(classes).toContain("text-xl");
		expect(classes).toContain("md:text-xl");
		expect(classes).not.toContain("md:text-sm");
		expect(classes).toContain("px-0");
		expect(classes).toContain("focus-visible:ring-0");
	});
});
