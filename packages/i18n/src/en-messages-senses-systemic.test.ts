import { describe, expect, test } from "bun:test";
import { I18nRuntime } from "./core.ts";
import {
	EN_SENSE_MESSAGES,
	OFFICIAL_SENSE_MESSAGES,
} from "./en-messages-senses.ts";
import {
	EN_SENSE_MESSAGES_SYSTEMIC,
	OFFICIAL_SENSE_MESSAGES_SYSTEMIC,
} from "./en-messages-senses-systemic.ts";
import { messageIdForLiteral } from "./literal-catalog.ts";

describe("systemic-round senses", () => {
	test("merge into the sense catalog for every official locale", () => {
		for (const [id, source] of Object.entries(EN_SENSE_MESSAGES_SYSTEMIC)) {
			expect(EN_SENSE_MESSAGES[id as keyof typeof EN_SENSE_MESSAGES]).toBe(
				source
			);
		}
		expect(Object.keys(OFFICIAL_SENSE_MESSAGES_SYSTEMIC).sort()).toEqual(
			Object.keys(OFFICIAL_SENSE_MESSAGES).sort()
		);
		for (const [locale, senses] of Object.entries(
			OFFICIAL_SENSE_MESSAGES_SYSTEMIC
		)) {
			expect(Object.keys(senses).sort()).toEqual(
				Object.keys(EN_SENSE_MESSAGES_SYSTEMIC).sort()
			);
			for (const [id, value] of Object.entries(senses)) {
				expect(
					OFFICIAL_SENSE_MESSAGES[locale]?.[
						id as keyof typeof EN_SENSE_MESSAGES
					]
				).toBe(value);
			}
		}
	});

	test("each sense reads apart from the bare word's catalog sense", () => {
		// The bare words: "Lifetime" a purchase (ja 買い切り), "Memory" agent
		// memory (de Gedächtnis, zh-CN 记忆), "Contents" what a thing holds
		// (ja 内容), "Incoming" a change's new side (ja 新規), "Destination" a
		// save location (ja 保存先), "Entry" admission (de Einlass) and "Note"
		// an annotation (zh-CN 批注).
		const expected: Record<string, Record<string, string>> = {
			de: {
				"hardware.memory": "Arbeitsspeicher",
				"journal.entry": "Eintrag",
				"usage.lifetime": "Gesamt",
			},
			fr: { "nav.tableOfContents": "Sommaire" },
			ja: {
				"calls.incoming": "着信",
				"dataGrid.checked": "チェックあり",
				"departures.destinationColumn": "行き先",
				"import.created": "作成",
				"nav.tableOfContents": "目次",
				"runs.started": "開始済み",
				"usage.lifetime": "累計",
			},
			ko: { "nav.tableOfContents": "목차" },
			ru: { "nav.tableOfContents": "Содержание" },
			"zh-CN": {
				"hardware.memory": "内存",
				"nav.tableOfContents": "目录",
				"records.noteField": "备注",
			},
		};
		for (const [locale, senses] of Object.entries(expected)) {
			const runtime = new I18nRuntime([], {
				initialPackId: `official/${locale.toLowerCase()}`,
			});
			for (const [id, value] of Object.entries(senses)) {
				const source =
					EN_SENSE_MESSAGES_SYSTEMIC[
						id as keyof typeof EN_SENSE_MESSAGES_SYSTEMIC
					];
				expect({
					id,
					locale,
					value: runtime.translate(id, {}, source),
				}).toEqual({ id, locale, value });
			}
		}
		for (const word of ["Contents", "Destination", "Lifetime", "Memory"]) {
			expect(messageIdForLiteral(word).startsWith("literal.")).toBe(true);
		}
	});
});
