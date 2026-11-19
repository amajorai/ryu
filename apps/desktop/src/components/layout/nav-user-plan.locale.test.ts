// The account menu's trial chip is a plan tier (de "Testphase", ru "Пробный
// период") and reads through the keyed `plans.trialTier`. The bare catalog
// "Trial" is an agent lifecycle stage (de "Test", ru "Тестирование").
import { afterEach, expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { planLabel } from "./nav-user-plan.ts";

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

test("the German trial chip names the trial period", () => {
	useLocale("official/de");
	expect(planLabel(null, true)).toBe("Testphase");
});

test("the Russian trial chip names the trial period", () => {
	useLocale("official/ru");
	expect(planLabel(null, true)).toBe("Пробный период");
});

test("English keeps Trial, and a paid plan keeps its name", () => {
	expect(planLabel(null, true)).toBe("Trial");
	expect(planLabel(null, false)).toBe("Free");
	expect(planLabel("pro", true)).toBe("Ryu Pro");
});
