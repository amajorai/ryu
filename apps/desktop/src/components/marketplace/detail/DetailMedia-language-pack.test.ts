import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { languagePackRowValue } from "./DetailMedia-language-pack.ts";

test("a language pack's row is one catalogued template", () => {
	const tl: LiteralMessage = (source, values) =>
		`[${source}]${values ? JSON.stringify(values) : ""}`;
	expect(
		languagePackRowValue(
			{ baseLocale: "en", direction: "rtl", locale: "ar", messageCount: 4200 },
			tl
		)
	).toBe(
		'[{locale} · {baseLocale} · {direction} · {messageCount, plural, one {# string} other {# strings}}]{"baseLocale":"en","direction":"RTL","locale":"ar","messageCount":4200}'
	);
});
