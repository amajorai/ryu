import { describe, expect, test } from "bun:test";
import { I18nRuntime } from "./core.ts";
import { OFFICIAL_SENSE_MESSAGES } from "./en-messages-senses.ts";
import {
	EN_SENSE_MESSAGES_VOICE,
	OFFICIAL_SENSE_MESSAGES_VOICE,
} from "./en-messages-senses-voice.ts";

// Voice reads `t("voice.studio.<key>", {}, "English")`; these entries give the
// exact ids their Voice meaning instead of the bare catalog word's.

describe("Voice Studio senses", () => {
	test("every official locale carries every Voice sense", () => {
		const ids = Object.keys(EN_SENSE_MESSAGES_VOICE).sort();
		for (const [locale, senses] of Object.entries(
			OFFICIAL_SENSE_MESSAGES_VOICE
		)) {
			expect(Object.keys(senses).sort()).toEqual(ids);
			for (const [id, value] of Object.entries(senses)) {
				expect(
					OFFICIAL_SENSE_MESSAGES[locale]?.[
						id as keyof (typeof OFFICIAL_SENSE_MESSAGES)[string]
					]
				).toBe(value);
			}
		}
	});

	test("the Studio and Stories controls read in their Voice sense", () => {
		const german = new I18nRuntime([], { initialPackId: "official/de" });
		const japanese = new I18nRuntime([], { initialPackId: "official/ja" });
		// de "Sprache" is a language; "Spracherkennungsmodell" speech recognition.
		expect(german.translate("voice.studio.settings.voice", {}, "Voice")).toBe(
			"Stimme"
		);
		expect(
			japanese.translate("voice.studio.settings.engine", {}, "Speech model")
		).toBe("音声合成モデル");
		// Delivery is how a line is read aloud, not shipping (ja 受け渡し).
		for (const id of [
			"voice.studio.advanced.delivery",
			"voice.studio.advanced.deliveryAria",
			"voice.studio.stories.instruct",
		]) {
			expect(japanese.translate(id, {}, "Delivery")).toBe("読み方のスタイル");
			expect(german.translate(id, {}, "Delivery")).toBe("Vortragsweise");
		}
		// A script line, not a phone line (ja 回線), and a story, not an article.
		expect(
			japanese.translate("voice.studio.stories.addLine", {}, "Add line")
		).toBe("行を追加");
		expect(
			japanese.translate(
				"voice.studio.stories.lineLabel",
				{ number: 3 },
				"Line {number}"
			)
		).toBe("3 行目");
		expect(
			japanese.translate("voice.studio.stories.create", {}, "New story")
		).toBe("新しいストーリー");
	});
});
