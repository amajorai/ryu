// The visual editor's link address field is a hyperlink (fr "Lien") and reads
// through the keyed `editor.hyperlink`. The bare catalog "Link" is the
// account-linking verb (fr "Associer").
import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { VisualEditorInspector } from "./visual-editor-inspector.tsx";

/** A selected `<a>` element: the inspector reads only these members. */
const anchor = {
	getAttribute: () => null,
	textContent: "",
} as unknown as Element;

function fieldLabels(locale: string): string[] {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={locale === "en" ? null : `official/${locale}`}
			manageDocument={false}
			overlays={{ fr: { Link: "Associer" } }}
		>
			<VisualEditorInspector
				apply={() => true}
				disabled={false}
				fieldKey="k"
				isLeaf={false}
				moveSelected={() => undefined}
				selected={anchor}
				selectedId="node-1"
				selectedStyle={undefined}
				selectedTag="a"
			/>
		</I18nProvider>
	);
	return [...html.matchAll(/<label[^>]*>([^<]*)</g)].map(
		(match) => match[1] ?? ""
	);
}

test("the French inspector labels the link address Lien", () => {
	const labels = fieldLabels("fr");
	expect(labels).toContain("Lien");
	expect(labels).not.toContain("Associer");
});

test("English keeps Link", () => {
	expect(fieldLabels("en")).toContain("Link");
});
