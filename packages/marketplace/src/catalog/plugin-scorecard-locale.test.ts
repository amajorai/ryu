// The plugin scorecard's counted and dated details are whole ICU messages: the
// English sentences read correctly in the singular, and another UI locale gets
// its own plural categories and relative-age words rather than English glue.

import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { runScorecard } from "./plugin-scorecard.ts";
import { agoLabel } from "./scorecard-contract.ts";
import type { CatalogEntry, PluginCatalogDetail } from "./types.ts";

const NOW = Date.parse("2026-07-24T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

const STARS =
	"{count, plural, one {# star} other {# stars}} — little independent usage to learn from.";
const STARS_RU =
	"{count, plural, one {# звезда} few {# звезды} many {# звёзд} other {# звезды}} — мало независимого использования.";
const UPDATED = "Last updated {age}.";
const UPDATED_RU = "Последнее обновление: {age}.";

const russian = {
	direction: "ltr" as const,
	locale: "ru",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		let message = fallback;
		if (fallback === STARS) {
			message = STARS_RU;
		} else if (fallback === UPDATED) {
			message = UPDATED_RU;
		}
		return formatMessage(message ?? source, values, "ru");
	},
};

const entry: CatalogEntry = {
	description: "A plugin that does a specific, clearly explained thing.",
	id: "com.example.thing",
	kinds: ["tool"],
	name: "Thing",
	tags: [],
};

function detailOf(
	overrides: Partial<PluginCatalogDetail> = {}
): PluginCatalogDetail {
	return {
		apiSurface: {
			sidecars: [
				{
					name: "server",
					routes: [{ auth: "none", methods: ["GET"], path: "/open" }],
				},
			],
			tools: [{ id: "dangling", name: "" }],
		},
		description: "A plugin that does a specific, clearly explained thing.",
		issuesEnabled: true,
		openIssues: 3,
		origin: "community",
		stars: 1,
		updatedAt: daysAgo(30),
		versions: [
			{ publishedAt: daysAgo(400), version: "1.4.2" },
			{ publishedAt: daysAgo(500), version: "1.4.1" },
		],
		...overrides,
	};
}

const detailFor = (id: string, detail = detailOf()) =>
	runScorecard(entry, detail, NOW).checks.find((check) => check.id === id)
		?.detail;

describe("plugin scorecard copy", () => {
	afterEach(() => {
		unregisterActiveI18nRuntime(russian);
	});

	test("English counts agree with their nouns", () => {
		expect(detailFor("adoption")).toBe(
			"1 star — little independent usage to learn from."
		);
		expect(detailFor("adoption", detailOf({ stars: 40 }))).toBe(
			"40 stars — used by other people."
		);
		expect(detailFor("release-history")).toBe("2 published versions.");
		expect(detailFor("network-surface")).toBe(
			"1 HTTP route is exposed without authentication."
		);
		expect(detailFor("manifest-integrity")).toBe(
			"1 declared contribution references something the plugin does not ship."
		);
		expect(detailFor("issue-tracker")).toBe("Issue tracker is open (3 open).");
	});

	test("English ages keep their existing wording", () => {
		expect(detailFor("activity")).toBe("Last updated 30 days ago.");
		expect(detailFor("release-recency")).toBe(
			"Latest version 1.4.2 shipped 1.1 years ago."
		);
		expect(agoLabel(0, "en")).toBe("today");
		expect(agoLabel(1, "en")).toBe("yesterday");
		expect(agoLabel(120, "en")).toBe("4 months ago");
		expect(agoLabel(365, "en")).toBe("1 year ago");
		expect(agoLabel(730, "en")).toBe("2 years ago");
	});

	test("non-finite reports still read without throwing", () => {
		expect(
			detailFor("adoption", detailOf({ stars: Number.POSITIVE_INFINITY }))
		).toBe("Infinity stars — used by other people.");
		expect(
			detailFor("issue-tracker", detailOf({ openIssues: Number.NaN }))
		).toBe("Issue tracker is open (NaN open).");
	});

	test("another locale gets its plural categories and relative ages", () => {
		registerActiveI18nRuntime(russian);
		expect(detailFor("adoption")).toBe(
			"1 звезда — мало независимого использования."
		);
		expect(detailFor("adoption", detailOf({ stars: 3 }))).toBe(
			"3 звезды — мало независимого использования."
		);
		expect(detailFor("activity")).toBe("Последнее обновление: 30 дней назад.");
		expect(agoLabel(1)).toBe("вчера");
	});
});
