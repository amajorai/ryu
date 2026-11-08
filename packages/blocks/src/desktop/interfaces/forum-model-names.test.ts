import { afterEach, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { joinNames } from "./forum-model.ts";

// The forum byline list follows the UI locale's list pattern instead of an
// English comma glued to a translated final "and".
const JA: Record<string, string> = { "{names} and {last}": "{names}と{last}" };
const japanese = {
	direction: "ltr" as const,
	locale: "ja",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(JA[fallback ?? id] ?? fallback ?? id, values, "ja");
	},
};

afterEach(() => unregisterActiveI18nRuntime(japanese));

test("joins names with the Japanese list pattern, not an English comma", () => {
	registerActiveI18nRuntime(japanese);
	const joined = joinNames(["Atlas", "Echo", "Forge"]);
	expect(joined).toBe(
		new Intl.ListFormat("ja", { type: "conjunction" }).format([
			"Atlas",
			"Echo",
			"Forge",
		])
	);
	expect(joined).not.toContain(", ");
});

test("keeps one name as is and lists names in English otherwise", () => {
	expect(joinNames(["Atlas"])).toBe("Atlas");
	expect(joinNames([])).toBe("");
	expect(joinNames(["Atlas", "Echo"])).toBe("Atlas and Echo");
});
