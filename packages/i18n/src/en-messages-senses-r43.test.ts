import { describe, expect, test } from "bun:test";
import { I18nRuntime } from "./core.ts";
import {
	EN_SENSE_MESSAGES,
	OFFICIAL_SENSE_MESSAGES,
} from "./en-messages-senses.ts";
import {
	EN_SENSE_MESSAGES_R43,
	OFFICIAL_SENSE_MESSAGES_R43,
} from "./en-messages-senses-r43.ts";

const runtimeFor = (locale: string) =>
	new I18nRuntime([], { initialPackId: `official/${locale.toLowerCase()}` });

describe("round 43 senses", () => {
	test("merge into the sense catalog for every official locale", () => {
		for (const [id, source] of Object.entries(EN_SENSE_MESSAGES_R43)) {
			expect(EN_SENSE_MESSAGES[id as keyof typeof EN_SENSE_MESSAGES]).toBe(
				source
			);
		}
		expect(Object.keys(OFFICIAL_SENSE_MESSAGES_R43).sort()).toEqual(
			Object.keys(OFFICIAL_SENSE_MESSAGES).sort()
		);
		for (const [locale, senses] of Object.entries(
			OFFICIAL_SENSE_MESSAGES_R43
		)) {
			for (const [id, value] of Object.entries(senses)) {
				expect({
					id,
					locale,
					value:
						OFFICIAL_SENSE_MESSAGES[locale]?.[
							id as keyof typeof EN_SENSE_MESSAGES
						],
				}).toEqual({ id, locale, value });
			}
		}
	});

	test("each sense resolves apart from the bare word's catalog sense", () => {
		// The bare words: audio recording (ja 録音), an exam item (ja 問題), an
		// FAQ (zh-CN 常见问题), a dismiss button (ja 後で), open for entries (ja
		// 受付中), processing (de "In Bearbeitung"), a tale (de "Geschichten"),
		// a save status (ja 保存しました), an invoice date (ja 支払期日) and a
		// pitch deadline (ja 今週中に).
		const expected: Record<string, Record<string, string>> = {
			de: {
				"devices.foreground": "App geöffnet",
				"news.storiesTab": "Meldungen",
				"tracking.inTransit": "Unterwegs",
			},
			fr: { "forms.questionBlocks": "Types de questions" },
			ja: {
				"clips.startRecording": "録画を開始",
				"clips.stopRecording": "録画を停止",
				"forms.addQuestion": "質問を追加",
				"forms.removeQuestion": "質問を削除",
				"missionControl.touchNew": "新規",
				"news.savedTab": "保存済み",
				"projects.dueDate": "期限",
				"showcase.thisWeek": "今週",
				"time.notYet": "まだ",
				"tracking.inTransit": "配送中",
				"workflows.startRecording": "記録を開始",
			},
			ru: { "projects.dueDate": "Срок", "time.notYet": "Ещё нет" },
			"zh-CN": { "forms.questionBlocks": "问题", "time.notYet": "尚未" },
		};
		for (const [locale, senses] of Object.entries(expected)) {
			const runtime = runtimeFor(locale);
			for (const [id, value] of Object.entries(senses)) {
				const source =
					EN_SENSE_MESSAGES_R43[id as keyof typeof EN_SENSE_MESSAGES_R43];
				expect({
					id,
					locale,
					value: runtime.translate(id, {}, source),
				}).toEqual({ id, locale, value });
			}
		}
	});
});
