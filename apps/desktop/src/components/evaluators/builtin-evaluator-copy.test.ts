import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { messageIdForLiteral } from "@ryu/i18n/core";
import type { Evaluator } from "@/src/lib/api/gateway.ts";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import {
	BUILTIN_EVALUATOR_COPY,
	evaluatorDisplayCopy,
} from "./builtin-evaluator-copy.ts";
import { toCatalogItem } from "./catalog-utils.ts";

const JA: Record<string, string> = {
	"PII Leakage": "個人情報の漏えい",
	"Detects personally identifiable information in model output.":
		"モデルの出力に含まれる個人を特定できる情報を検出します。",
	Tone: "トーン",
};

// A Japanese runtime keyed the way the provider keys its literal catalog.
const ja: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "ja",
	translate(id, _values, fallback) {
		for (const [source, text] of Object.entries(JA)) {
			if (messageIdForLiteral(source) === id) {
				return text;
			}
		}
		return fallback ?? id;
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(ja);
});

function evaluator(overrides: Partial<Evaluator>): Evaluator {
	return {
		id: "pii_leakage",
		name: "PII Leakage",
		description: "Detects personally identifiable information in model output.",
		category: "security",
		target: "output",
		capabilities: { inline: true, offline: true },
		impl: { kind: "regex", patterns: [] },
		inline: null,
		offline: null,
		builtin: true,
		enforced: true,
		higherIsBetter: true,
		...overrides,
	};
}

describe("built-in evaluator copy", () => {
	test("a built-in shows its name and description in the UI language", () => {
		registerActiveI18nRuntime(ja);
		const item = toCatalogItem(evaluator({}));
		expect(item.name).toBe("個人情報の漏えい");
		expect(item.description).toBe(
			"モデルの出力に含まれる個人を特定できる情報を検出します。"
		);
	});

	test("a custom evaluator keeps its text, even with a built-in's id or name", () => {
		registerActiveI18nRuntime(ja);
		const custom = evaluator({
			id: "tone",
			name: "Tone",
			description: "My own tone rubric.",
			builtin: false,
		});
		expect(evaluatorDisplayCopy(custom)).toEqual({
			name: "Tone",
			description: "My own tone rubric.",
		});
	});

	test("a built-in the table does not know keeps the Gateway's text", () => {
		registerActiveI18nRuntime(ja);
		const unknown = evaluator({
			id: "future_detector",
			name: "Future Detector",
			description: "Shipped by a newer Gateway.",
		});
		expect(toCatalogItem(unknown).name).toBe("Future Detector");
		expect(evaluatorDisplayCopy(evaluator({ id: "toString" })).name).toBe(
			"PII Leakage"
		);
	});

	test("English copy matches the Gateway seed for every built-in", () => {
		const source = readFileSync(
			new URL("../../../../gateway/src/evaluators/catalog.rs", import.meta.url),
			"utf8"
		);
		const seeds = [
			...source.matchAll(
				/seed\(\s*"([^"]+)",\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"/gu
			),
		].map(([, id, name, description]) => ({
			id,
			name,
			description: description?.replaceAll('\\"', '"'),
		}));
		expect(seeds.length).toBeGreaterThanOrEqual(30);
		const seededIds = seeds.map((seed) => seed.id).sort();
		expect(Object.keys(BUILTIN_EVALUATOR_COPY).sort()).toEqual(seededIds);
		for (const seed of seeds) {
			const copy = BUILTIN_EVALUATOR_COPY[seed.id ?? ""];
			expect({
				id: seed.id,
				name: copy?.title,
				description: copy?.description,
			}).toEqual(seed);
		}
	});
});
