// The deliveries tab "On the way" is a parcel in transit (ja 配送中, de
// "Unterwegs") through the keyed `tracking.inTransit`, and a step not reached
// yet reads "not yet" (ja まだ) through `time.notYet`. The bare catalog rows
// are a processing status (ja 処理中) and a dismiss button (ja 後で).
import { afterEach, expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { TRACKING_TABS } from "./tracking-model.ts";
import { stepStateText } from "./tracking-route.tsx";

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

const inTransitTab = () =>
	TRACKING_TABS.find((tab) => tab.id === "on-the-way")?.label;

test("the Japanese deliveries tab and upcoming step read in their parcel sense", () => {
	useLocale("official/ja");
	expect(inTransitTab()).toBe("配送中");
	expect(stepStateText("upcoming")).toBe("まだ");
});

test("the German deliveries tab says Unterwegs", () => {
	useLocale("official/de");
	expect(inTransitTab()).toBe("Unterwegs");
});

test("without a provider the English stays", () => {
	expect(inTransitTab()).toBe("On the way");
	expect(stepStateText("upcoming")).toBe("Not yet");
	expect(stepStateText("done")).toBe("Done");
});
