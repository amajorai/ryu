import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { inboxHiddenLabel } from "./InboxCenter-hidden-label.ts";

const INBOX =
	"{hidden, plural, one {# more in the full inbox} other {# more in the full inbox}}";
const ANNOUNCEMENTS =
	"{hidden, plural, one {# more in announcements} other {# more in announcements}}";

// Stub rows standing in for the catalog rows the coordinator generates.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		[ANNOUNCEMENTS]:
			"{hidden, plural, zero {لا شيء آخر في الإعلانات} one {إعلان آخر} two {إعلانان آخران} few {# إعلانات أخرى} many {# إعلانًا آخر} other {# إعلان آخر}}",
		[INBOX]:
			"{hidden, plural, zero {لا شيء آخر} one {عنصر آخر في صندوق الوارد} two {عنصران آخران في صندوق الوارد} few {# عناصر أخرى في صندوق الوارد} many {# عنصرًا آخر في صندوق الوارد} other {# عنصر آخر في صندوق الوارد}}",
	},
	de: {
		[INBOX]:
			"{hidden, plural, one {# weiterer Eintrag im Posteingang} other {# weitere Einträge im Posteingang}}",
	},
	en: {},
};

function translatorFor(locale: string): LiteralMessage {
	return (source, values) =>
		formatMessage(CATALOGS[locale]?.[source] ?? source, values, locale);
}

describe("inboxHiddenLabel", () => {
	test("keeps the English footer copy", () => {
		const tl = translatorFor("en");
		expect(inboxHiddenLabel(1, true, tl)).toBe("1 more in the full inbox");
		expect(inboxHiddenLabel(4, false, tl)).toBe("4 more in announcements");
	});

	test("selects the German singular and plural forms", () => {
		const tl = translatorFor("de");
		expect(inboxHiddenLabel(1, true, tl)).toBe(
			"1 weiterer Eintrag im Posteingang"
		);
		expect(inboxHiddenLabel(5, true, tl)).toBe(
			"5 weitere Einträge im Posteingang"
		);
	});

	test("selects distinct Arabic forms for 1, 2 and 11", () => {
		const tl = translatorFor("ar");
		expect(inboxHiddenLabel(1, true, tl)).toBe("عنصر آخر في صندوق الوارد");
		expect(inboxHiddenLabel(2, true, tl)).toBe("عنصران آخران في صندوق الوارد");
		expect(inboxHiddenLabel(11, false, tl)).toBe("11 إعلانًا آخر");
	});
});
