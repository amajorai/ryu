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

describe("settings search size", () => {
	test("is a borderless, muted, compact field without base-size text", () => {
		const classes = cn(inputVariants({ size: "settings-search" })).split(" ");
		for (const expected of [
			"h-8",
			"rounded-lg",
			"border-0",
			"bg-muted/50",
			"px-2",
			"text-sm",
		]) {
			expect(classes).toContain(expected);
		}
		expect(classes).not.toContain("text-base");
		expect(classes).not.toContain("rounded-3xl");
		expect(classes).not.toContain("bg-input/50");
		expect(classes).toContain("focus-visible:ring-3");
	});
});
