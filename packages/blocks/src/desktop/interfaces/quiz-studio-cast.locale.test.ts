// The studio host's name plate is the game-show host (ja "司会", de
// "Moderator") and reads through the keyed `quiz.hostRole`. The bare catalog
// "Host" is hosting (de "Hosten").
import { afterEach, expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import type { MemberLooks } from "./game3d-villager.tsx";
import { HOST_ID, studioExtras } from "./quiz-studio-cast.ts";

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

function hostName(): string | undefined {
	const looks = new Map([[HOST_ID, {} as MemberLooks]]);
	return studioExtras(looks, [0, 0], false)[0]?.name;
}

test("the German host plate names the presenter, not hosting", () => {
	useLocale("official/de");
	expect(hostName()).toBe("Moderator");
});

test("the Japanese host plate names the quiz host", () => {
	useLocale("official/ja");
	expect(hostName()).toBe("司会");
});

test("English keeps Host", () => {
	expect(hostName()).toBe("Host");
});
