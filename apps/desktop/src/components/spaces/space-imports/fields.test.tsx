import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArgumentField } from "./fields.tsx";

// A boolean import argument's closed trigger shows "True"/"False" in the UI
// language. A bare <SelectValue /> without `items` printed the raw "true".

function shippedCatalog(locale: string): Record<string, string> {
	const path = fileURLToPath(
		new URL(
			`../../../../../../packages/i18n/locales/${locale}.json`,
			import.meta.url
		)
	);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

function triggerText(locale: string, value: string): string {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
			manageDocument={false}
			overlays={{ [locale]: shippedCatalog(locale) }}
		>
			<ArgumentField
				name="include_archived"
				onChange={() => undefined}
				property={{ type: "boolean" }}
				required={false}
				value={value}
			/>
		</I18nProvider>
	);
	const start = html.indexOf('data-slot="select-trigger"');
	return html
		.slice(start, html.indexOf("</button>", start))
		.replaceAll(/<[^>]*>/g, "");
}

describe("ArgumentField boolean select", () => {
	test("shows the German label for a stored true", () => {
		const expected = shippedCatalog("de").True;
		expect(expected).toBeTruthy();
		const text = triggerText("de", "true");
		expect(text).toContain(expected ?? "");
		expect(text).not.toContain("true");
	});

	test("shows the English label for a stored false", () => {
		expect(triggerText("en", "false")).toContain("False");
	});
});
