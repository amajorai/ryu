// A podium's "Out" is a contestant out of the game (ja "脱落") and reads
// through the keyed `quiz.contestantOut`. The bare catalog "Out" is token
// output (ja "出力"), and the podium screen is canvas text the DOM localizer
// never reaches.
import { afterEach, expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { PODIUM_WORD_MAX, podiumWords } from "./quiz-acts.tsx";

/** Only the fields `podiumWords` reads for a limited contestant. */
const LIMITED = {
	act: "limited",
	agentName: "Fa",
	blockers: [],
	bubble: null,
} as unknown as InterfaceAgentAct;

let active: I18nRuntime | null = null;

function useLocale(packId: string): void {
	active = new I18nRuntime([], { initialPackId: packId });
	registerActiveI18nRuntime(active);
}

afterEach(() => {
	if (active) {
		unregisterActiveI18nRuntime(active);
		active = null;
	}
});

test("the Japanese podium says the contestant is out of the game", () => {
	useLocale("official/ja");
	expect(podiumWords(LIMITED)).toBe("脱落");
});

test("the Korean podium says the contestant is out of the game", () => {
	useLocale("official/ko");
	expect(podiumWords(LIMITED)).toBe("탈락");
});

test("every official locale's podium word fits the screen", () => {
	for (const locale of [
		"ar",
		"de",
		"es",
		"fr",
		"hi",
		"it",
		"ja",
		"ko",
		"pt-br",
		"ru",
		"zh-cn",
	]) {
		useLocale(`official/${locale}`);
		const word = podiumWords(LIMITED);
		expect({ locale, short: word.length <= PODIUM_WORD_MAX }).toEqual({
			locale,
			short: true,
		});
		expect({ locale, word }).not.toEqual({ locale, word: "Out" });
		unregisterActiveI18nRuntime(active as I18nRuntime);
		active = null;
	}
});

test("English keeps Out", () => {
	expect(podiumWords(LIMITED)).toBe("Out");
});
