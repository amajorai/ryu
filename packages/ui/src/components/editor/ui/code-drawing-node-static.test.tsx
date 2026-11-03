import { describe, expect, test } from "bun:test";
import { messageIdForLiteral } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import type { SlateElementProps } from "platejs/static";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeDrawingElementStatic } from "./code-drawing-node-static.tsx";

// The DOM localizer skips <pre>/<code>, so the empty code drawing's
// placeholder has to be translated where it is rendered.
const PLACEHOLDER = "Enter your code here…";
const PACK = {
	baseLocale: "es",
	direction: "ltr" as const,
	id: "community/code-drawing-es",
	locale: "es",
	messages: { [messageIdForLiteral(PLACEHOLDER)]: "Escribe tu código aquí…" },
	name: "Code drawing",
	schemaVersion: 1 as const,
	version: "1.0.0",
};

type StaticProps = ComponentProps<typeof CodeDrawingElementStatic>;

function renderDrawing(code: string | undefined, withPack: boolean): string {
	// The static node only reads `element` and passes the rest to SlateElement,
	// which renders `attributes` on its root.
	const props = {
		attributes: { "data-slate-node": "element" },
		children: null,
		editor: {},
		element: { children: [{ text: "" }], data: { code }, type: "code_drawing" },
	} as unknown as SlateElementProps & StaticProps;
	const node = <CodeDrawingElementStatic {...props} />;
	return renderToStaticMarkup(
		withPack ? (
			<I18nProvider initialPackId={PACK.id} packs={[PACK]}>
				{node}
			</I18nProvider>
		) : (
			node
		)
	);
}

describe("static code drawing placeholder", () => {
	test("follows the display language", () => {
		const html = renderDrawing(undefined, true);
		expect(html).toContain("Escribe tu código aquí…");
		expect(html).not.toContain(PLACEHOLDER);
	});

	test("stays English without a language pack and never replaces real code", () => {
		expect(renderDrawing(undefined, false)).toContain(PLACEHOLDER);
		const html = renderDrawing("graph TD; A-->B", true);
		expect(html).toContain("graph TD; A--&gt;B");
		expect(html).not.toContain("Escribe tu código aquí…");
	});
});
