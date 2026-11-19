// A paired phone whose platform is unknown is named as the device (ja
// "スマートフォン", ko "휴대폰") through the keyed `hardware.devicePhone`. The
// bare catalog "Phone" is a phone number there (ja "電話番号", ko "전화번호").
import { afterEach, expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import {
	foregroundLabel,
	platformLabel,
} from "./ConnectionsTab-paired-phone-row.tsx";

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

test("the Japanese row names an unknown platform as a smartphone", () => {
	useLocale("official/ja");
	expect(platformLabel("")).toBe("スマートフォン");
});

test("the Korean row names an unknown platform as a mobile phone", () => {
	useLocale("official/ko");
	expect(platformLabel("")).toBe("휴대폰");
});

test("English keeps Phone and the known platforms", () => {
	expect(platformLabel("")).toBe("Phone");
	expect(platformLabel("ios")).toBe("iPhone");
	expect(platformLabel("android")).toBe("Android");
});

// "Open now" means the Ryu app is open on the phone (ja アプリを使用中), not
// open for entries (the bare catalog row, ja 受付中, fr "Ouverts").
test("a phone with the app open reads in the device sense", () => {
	useLocale("official/ja");
	expect(foregroundLabel()).toBe("アプリを使用中");
	unregisterActiveI18nRuntime(active as I18nRuntime);
	useLocale("official/fr");
	expect(foregroundLabel()).toBe("App ouverte");
});

test("English keeps Open now", () => {
	expect(foregroundLabel()).toBe("Open now");
});
