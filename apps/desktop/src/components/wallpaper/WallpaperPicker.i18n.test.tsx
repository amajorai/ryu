// The picker's "Link" tab is an image link (fr "Lien") and reads through the
// keyed `editor.hyperlink`. The bare catalog "Link" is the account-linking
// verb (fr "Associer").
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = globalThis.document === undefined;
if (ownsDom) {
	GlobalRegistrator.register();
}

const { renderToStaticMarkup } = await import("react-dom/server");
const { I18nProvider } = await import("@ryu/i18n/react");
const { WallpaperPicker } = await import("./WallpaperPicker.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Stand-in for the verb sense of the bare catalog row. */
const OVERLAYS = { fr: { Link: "Associer" } };

function tabs(locale: string): string[] {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<WallpaperPicker />
		</I18nProvider>
	);
	return [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map(
		(match) => match[1] ?? ""
	);
}

test("the French link tab names a link, not the linking verb", () => {
	const names = tabs("fr");
	expect(names).toContain("Lien");
	expect(names).not.toContain("Associer");
});

test("English keeps the Link tab", () => {
	expect(tabs("en")).toContain("Link");
});
