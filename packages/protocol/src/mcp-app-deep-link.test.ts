import { expect, test } from "bun:test";
import { buildRyuDeepLink, parseRyuDeepLink } from "./deep-link.ts";

test("MCP app deep links preserve encoded identities and app-relative queries", () => {
	const input = {
		kind: "plugin-app",
		pluginId: "@team/cad",
		toolName: "cad.library",
		appPath: "/parts?tag=bolt&sort=asc",
	} as const;
	const link = buildRyuDeepLink(input);
	expect(link).toContain("ryu://plugins/%40team%2Fcad/app/cad.library");
	expect(parseRyuDeepLink(link)).toEqual(input);
	expect(parseRyuDeepLink("ryu://plugins/cad/app/library")).toMatchObject({
		appPath: "/",
	});
});

test("MCP app deep links reject external paths, fragments, and extra segments", () => {
	for (const path of [
		"https://example.com",
		"//example.com",
		"/parts#fragment",
		"/parts\\other",
	]) {
		expect(
			parseRyuDeepLink(
				`ryu://plugins/cad/app/library?path=${encodeURIComponent(path)}`
			)
		).toBeNull();
	}
	expect(parseRyuDeepLink("ryu://plugins/cad/app/library/extra")).toBeNull();
});
