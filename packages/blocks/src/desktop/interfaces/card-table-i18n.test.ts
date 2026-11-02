import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { Deck } from "./card-table-decks.ts";
import { deckSummary } from "./card-table-decks.ts";
import { tableSummary } from "./card-table-interface-layout.ts";

/*
 * The Card Table's counted copy is whole ICU messages, so a translator can
 * inflect each count (Arabic's few/many, German's one/other) and reorder the
 * parts. A fake catalog stands in for the official ones.
 */

const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		"{agents, plural, one {# agent} other {# agents}} · {running, plural, other {# running}} · {waiting, plural, other {# waiting on you}}":
			"{agents, plural, one {وكيل واحد} two {وكيلان} few {# وكلاء} other {# وكيل}} · {running, plural, other {# قيد التشغيل}} · {waiting, plural, other {# بانتظارك}}",
		"Dealing…": "جارٍ التوزيع…",
	},
	de: {
		"{agents, plural, one {# agent} other {# agents}} · {running, plural, other {# running}} · {waiting, plural, other {# waiting on you}}":
			"{agents, plural, one {# Agent} other {# Agenten}} · {running, plural, other {# aktiv}} · {waiting, plural, other {# warten auf dich}}",
		"{count, plural, one {# card} other {# cards}}":
			"{count, plural, one {# Karte} other {# Karten}}",
		"{count, plural, other {# failed}}":
			"{count, plural, other {# fehlgeschlagen}}",
		"{count, plural, other {# running}}": "{count, plural, other {# aktiv}}",
		"Dealing…": "Wird ausgeteilt…",
	},
	ja: {
		"{agents, plural, one {# agent} other {# agents}} · {running, plural, other {# running}} · {waiting, plural, other {# waiting on you}}":
			"エージェント {agents} 人 · 実行中 {running} · あなたの対応待ち {waiting}",
		"Dealing…": "配っています…",
	},
};

function literalsFor(locale: string): LiteralMessage {
	const catalog = CATALOGS[locale] ?? {};
	return (source: string, values?: MessageValuesInput) =>
		formatMessage(catalog[source] ?? source, values ?? {}, locale);
}

const english = literalsFor("en");

describe("card table counted copy", () => {
	test("English reads as before", () => {
		expect(tableSummary(null, english)).toBe("Dealing…");
		expect(tableSummary({ agents: 1, running: 0, waiting: 2 }, english)).toBe(
			"1 agent · 0 running · 2 waiting on you"
		);
		expect(tableSummary({ agents: 3, running: 1, waiting: 0 }, english)).toBe(
			"3 agents · 1 running · 0 waiting on you"
		);
	});

	test("the HUD summary is one message each locale can inflect", () => {
		expect(tableSummary(null, literalsFor("ja"))).toBe("配っています…");
		expect(
			tableSummary({ agents: 3, running: 1, waiting: 2 }, literalsFor("ja"))
		).toBe("エージェント 3 人 · 実行中 1 · あなたの対応待ち 2");
		const ar = literalsFor("ar");
		expect(tableSummary({ agents: 2, running: 0, waiting: 0 }, ar)).toStartWith(
			"وكيلان"
		);
		expect(tableSummary({ agents: 3, running: 0, waiting: 0 }, ar)).toStartWith(
			"3 وكلاء"
		);
		expect(
			tableSummary({ agents: 1, running: 2, waiting: 1 }, literalsFor("de"))
		).toBe("1 Agent · 2 aktiv · 1 warten auf dich");
	});

	test("deck summaries count through the catalog", () => {
		const deck = {
			attention: 1,
			running: 2,
			threads: [{}, {}, {}],
			yourTurn: 0,
		} as unknown as Deck;
		expect(deckSummary(deck, english)).toBe("3 cards, 2 running, 1 failed");
		expect(deckSummary(deck, literalsFor("de"))).toBe(
			"3 Karten, 2 aktiv, 1 fehlgeschlagen"
		);
	});
});
