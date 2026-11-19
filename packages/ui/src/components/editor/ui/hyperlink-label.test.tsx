// The editor's link toolbar tooltip and the Insert menu's "Link" item are the
// hyperlink noun (fr "Lien", ru "Ссылка") and read through the keyed
// `editor.hyperlink`. The bare catalog "Link" is the account-linking verb.
import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useHyperlinkLabel } from "./hyperlink-label.ts";

/** Stand-in for the verb sense of the bare catalog row. */
const OVERLAYS = { fr: { Link: "Associer" }, ru: { Link: "Привязать" } };

function Label() {
	return <span>{useHyperlinkLabel()}</span>;
}

function label(locale: string): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<Label />
		</I18nProvider>
	);
}

test("the French hyperlink label is a link, not the linking verb", () => {
	expect(label("fr")).toBe("<span>Lien</span>");
});

test("the Russian hyperlink label is a link, not the linking verb", () => {
	expect(label("ru")).toBe("<span>Ссылка</span>");
});

test("English keeps Link, also without a provider", () => {
	expect(label("en")).toBe("<span>Link</span>");
	expect(renderToStaticMarkup(<Label />)).toBe("<span>Link</span>");
});
