import { describe, expect, test } from "bun:test";
import {
	parseRouteWeight,
	routeWeightInvalid,
	routeWeightText,
} from "./route-weight-input.ts";

describe("route weight input", () => {
	test("reads a German comma decimal", () => {
		expect(parseRouteWeight("0,5", 1, "de")).toBe(0.5);
		expect(parseRouteWeight("2", 1, "de")).toBe(2);
	});

	test("reads an English period decimal", () => {
		expect(parseRouteWeight("0.25", 1, "en")).toBe(0.25);
	});

	test("an empty field reads as the caller's default", () => {
		expect(parseRouteWeight("  ", 1, "de")).toBe(1);
		expect(parseRouteWeight("", 0, "en")).toBe(0);
	});

	test("unreadable text is NaN and flagged", () => {
		expect(Number.isNaN(parseRouteWeight("abc", 1, "de"))).toBe(true);
		expect(routeWeightInvalid("abc", "de")).toBe(true);
		expect(routeWeightInvalid("-1", "de")).toBe(true);
		expect(routeWeightInvalid("0,5", "de")).toBe(false);
		expect(routeWeightInvalid("", "de")).toBe(false);
	});
});

describe("route weight prefill", () => {
	test("a saved weight reads back unchanged in every locale", () => {
		for (const locale of ["de", "fr", "en", "ja", "ar"]) {
			for (const weight of [0.125, 1.125, 2.5, 1000, 3]) {
				const text = routeWeightText(weight, locale);
				expect(parseRouteWeight(text, 0, locale)).toBe(weight);
			}
		}
	});

	test("German prefills a comma decimal and a missing weight as 1", () => {
		expect(routeWeightText(1.125, "de")).toBe("1,125");
		expect(routeWeightText(undefined, "de")).toBe("1");
		expect(routeWeightText(0.5, "en")).toBe("0.5");
	});
});
