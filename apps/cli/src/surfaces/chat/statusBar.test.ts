// The double-check badge is a bare lowercase word, which the extractor skips as
// JSX text; it is an explicit `tr` literal so the catalog keeps it.
import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";
import { doubleCheckBadgeLabel, routeChip } from "./statusBar.tsx";

describe("double-check badge", () => {
	test("is translated through the given translator", () => {
		const german = createCliTranslator("de", {
			"double-check": "Gegenprüfung",
		});
		expect(doubleCheckBadgeLabel(german.tr)).toBe("Gegenprüfung");
	});

	test("reads in English by default", () => {
		expect(doubleCheckBadgeLabel((value) => value)).toBe("double-check");
	});
});

describe("route chip", () => {
	test("the automatic route is translated; agent and team ids stay syntax", () => {
		const german = createCliTranslator("de", { auto: "automatisch" });
		expect(routeChip(null, null, german.tr)).toBe("automatisch");
		expect(routeChip("coder", null, german.tr)).toBe("agent:coder");
		expect(routeChip(null, "ops", german.tr)).toBe("team:ops");
	});
});
