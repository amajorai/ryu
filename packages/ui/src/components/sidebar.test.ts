import { describe, expect, test } from "bun:test";
import {
	parseSidebarOpenPreference,
	readSidebarOpenPreference,
} from "./sidebar.tsx";

describe("sidebar open preference", () => {
	test("parses the owned sidebar_state cookie without matching other names", () => {
		expect(parseSidebarOpenPreference("theme=dark; sidebar_state=false")).toBe(
			false
		);
		expect(parseSidebarOpenPreference("sidebar_state=true; theme=dark")).toBe(
			true
		);
		expect(
			parseSidebarOpenPreference("my_sidebar_state=false")
		).toBeUndefined();
		expect(parseSidebarOpenPreference("sidebar_state=invalid")).toBeUndefined();
	});

	test("defaults the current preference open when the cookie is missing", () => {
		expect(readSidebarOpenPreference("theme=dark")).toBe(true);
		expect(readSidebarOpenPreference("sidebar_state=false")).toBe(false);
	});
});
