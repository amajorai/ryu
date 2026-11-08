import { describe, expect, test } from "bun:test";

import {
	capturesFitTypes,
	captureType,
	looksTemporal,
} from "./literal-template-capture-types.ts";

describe("captureType", () => {
	test.each([
		["count", "", "numeric"],
		["n", "", "numeric"],
		["total", "", "numeric"],
		["memberCount", "", "numeric"],
		["stampTotal", "", "numeric"],
		["items", "{items, plural, other {# items}}", "numeric"],
		["time", "", "temporal"],
		["relativeTime", "", "temporal"],
		["createdAt", "", "temporal"],
		["endDate", "", "temporal"],
		["when", "{when, date, short}", "temporal"],
		["countLabel", "", "free"],
		["countText", "", "free"],
		["number", "", "free"],
		["issueNumber", "", "free"],
		["title", "", "free"],
		["kind", "{kind, select, file {File} other {Item}}", "free"],
	] as const)("%p in %p is %p", (name, translation, expected) => {
		expect(captureType(name, translation)).toBe(expected);
	});
});

describe("looksTemporal", () => {
	test.each([
		"yesterday",
		"just now",
		"2 hours ago",
		"in 3 days",
		"last Monday",
		"March 4",
		"10:42 AM",
		"less than a minute ago",
		"gestern",
		"ayer",
		"hier",
	])("reads %p as a time", (value) => {
		expect(looksTemporal(value)).toBe(true);
	});

	test.each([
		"startup",
		"as a@b.com",
		"the release",
		"",
	])("does not read %p as a time", (value) => {
		expect(looksTemporal(value)).toBe(false);
	});
});

describe("capturesFitTypes", () => {
	test("a count needs a numeral in any script", () => {
		expect(capturesFitTypes({ count: "List" })).toBe(false);
		expect(capturesFitTypes({ count: "15" })).toBe(true);
		expect(capturesFitTypes({ count: "١٥" })).toBe(true);
		expect(capturesFitTypes({ count: "99+" })).toBe(true);
	});

	test("a time needs a numeral or time words; free values take anything", () => {
		expect(capturesFitTypes({ title: "Sync", time: "startup" })).toBe(false);
		expect(capturesFitTypes({ title: "Sync", time: "noon" })).toBe(true);
		expect(capturesFitTypes({ name: "List" })).toBe(true);
	});
});
