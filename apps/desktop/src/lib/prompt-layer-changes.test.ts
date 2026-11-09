import { afterEach, describe, expect, test } from "bun:test";
import {
	pluralField,
	promptEditCacheWarning,
} from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import { promptLayerChanges } from "./prompt-layer-changes.ts";

const saved = {
	persona: { display_name: "Scout", output_style_id: null, tone: "warm" },
	skills: ["a", "b"],
	systemPrompt: "Be useful.",
};

const draft = {
	displayName: "Scout",
	outputStyleId: null,
	skills: ["b", "a"],
	systemPrompt: "Be useful.  ",
	tone: "warm",
};

describe("promptLayerChanges", () => {
	test("an unchanged prompt needs no confirmation", () => {
		expect(promptLayerChanges(saved, draft)).toEqual([]);
	});

	test("names every changed prompt layer", () => {
		expect(
			promptLayerChanges(saved, {
				...draft,
				outputStyleId: "concise",
				skills: ["a"],
				systemPrompt: "Be brief.",
				tone: null,
			})
		).toEqual([
			"The personality profile",
			pluralField("Skills"),
			"The name and tone",
			pluralField("The instructions"),
		]);
	});
});

describe("promptLayerChanges in another language", () => {
	const JA: Record<string, string> = {
		"The instructions": "指示",
		"The name and tone": "名前とトーン",
		"The personality profile": "パーソナリティプロファイル",
		Skills: "スキル",
	};
	const japanese = {
		direction: "ltr" as const,
		locale: "ja",
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			const source = fallback ?? id;
			return formatMessage(JA[source] ?? source, values ?? {});
		},
	};

	afterEach(() => {
		unregisterActiveI18nRuntime(japanese);
	});

	test("labels come from the catalog, and plural nouns stay marked", () => {
		registerActiveI18nRuntime(japanese);
		expect(
			promptLayerChanges(saved, {
				...draft,
				outputStyleId: "concise",
				skills: ["a"],
				systemPrompt: "Be brief.",
				tone: null,
			})
		).toEqual([
			"パーソナリティプロファイル",
			pluralField("スキル"),
			"名前とトーン",
			pluralField("指示"),
		]);
	});

	test("a lone plural layer takes the plural verb without English text", () => {
		registerActiveI18nRuntime(japanese);
		const changed = promptLayerChanges(saved, { ...draft, skills: ["a"] });
		const description =
			promptEditCacheWarning(changed, "bot", (source, values) =>
				formatMessage(source, values ?? {})
			)?.description ?? "";
		expect(description).toStartWith("スキル are part of");
		expect(description).not.toContain("Skills");
	});
});
