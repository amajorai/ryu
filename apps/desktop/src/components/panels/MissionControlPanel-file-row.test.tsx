import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileRow } from "./MissionControlPanel-file-row.tsx";

// A file row says what the turn did to the file (ja 新規, 読取; de geändert)
// through the `missionControl.touch*` senses, not the create, edit and read
// verbs.

function touchLabel(
	locale: string,
	kind: "create" | "edit" | "read"
): string | undefined {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={locale === "en" ? null : `official/${locale}`}
			manageDocument={false}
		>
			<FileRow touch={{ count: 2, kind, path: "src/app.ts" }} />
		</I18nProvider>
	);
	return /<span class="w-8[^"]*">([^<]*)</.exec(html)?.[1];
}

test("the file row names what the turn did", () => {
	expect(touchLabel("ja", "create")).toBe("新規");
	expect(touchLabel("ja", "read")).toBe("読取");
	expect(touchLabel("de", "edit")).toBe("geändert");
});

test("English keeps the short labels", () => {
	expect(touchLabel("en", "create")).toBe("new");
	expect(touchLabel("en", "edit")).toBe("edit");
	expect(touchLabel("en", "read")).toBe("read");
});
