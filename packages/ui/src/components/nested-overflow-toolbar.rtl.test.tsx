import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	layerVariants,
	NestedOverflowToolbar,
} from "./nested-overflow-toolbar.tsx";

// A nested toolbar layer slides in from the inline end and out toward the
// inline start, so under dir="rtl" the physical offsets flip sign.
describe("nested overflow toolbar layer motion", () => {
	test("left-to-right layers enter from the right and leave to the left", () => {
		const variants = layerVariants(1);
		expect(variants.enter.x).toBe(12);
		expect(variants.exit.x).toBe(-12);
		expect(variants.present.x).toBe(0);
	});

	test("right-to-left layers enter from the left and leave to the right", () => {
		const variants = layerVariants(-1);
		expect(variants.enter.x).toBe(-12);
		expect(variants.exit.x).toBe(12);
		expect(variants.present).toEqual({ opacity: 1, x: 0 });
	});
});

describe("nested overflow toolbar labels", () => {
	test("the expanded grid names the toolbar in the UI language", () => {
		const html = renderToStaticMarkup(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				manageDocument={false}
				overlays={{
					de: {
						"Editor tools": "Editorwerkzeuge",
						"{ariaLabel} expanded": "{ariaLabel} ausgeklappt",
					},
				}}
			>
				<NestedOverflowToolbar
					categories={[]}
					defaultOpen
					expandedLayout="grid"
					primary={null}
				/>
			</I18nProvider>
		);
		expect(html).toContain('aria-label="Editorwerkzeuge ausgeklappt"');
	});

	test("category groups and rail buttons translate the category name", () => {
		const overlays = {
			de: {
				Insert: "Einfügen",
				"Open {label} tools": "{label}-Werkzeuge öffnen",
				"{label} tools": "{label}-Werkzeuge",
			},
		};
		const categories = [
			{ content: null, icon: null, id: "insert", label: "Insert" },
		];
		const render = (expandedLayout: "grid" | "nested") =>
			renderToStaticMarkup(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de"
					manageDocument={false}
					overlays={overlays}
				>
					<NestedOverflowToolbar
						categories={categories}
						defaultOpen
						expandedLayout={expandedLayout}
						primary={null}
					/>
				</I18nProvider>
			);
		expect(render("grid")).toContain('aria-label="Einfügen-Werkzeuge"');
		expect(render("nested")).toContain(
			'aria-label="Einfügen-Werkzeuge öffnen"'
		);
	});

	test("the toolbar and its open and close toggle are named in the UI language", () => {
		const overlays = {
			de: {
				"Close editor tools": "Editor-Werkzeuge schließen",
				"Editor tools": "Editor-Werkzeuge",
				"Open editor tools": "Editor-Werkzeuge öffnen",
			},
		};
		const render = (defaultOpen: boolean) =>
			renderToStaticMarkup(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de"
					manageDocument={false}
					overlays={overlays}
				>
					<NestedOverflowToolbar
						categories={[]}
						defaultOpen={defaultOpen}
						expandedLayout="nested"
						primary={null}
					/>
				</I18nProvider>
			);
		const closed = render(false);
		expect(closed).toContain('aria-label="Editor-Werkzeuge öffnen"');
		expect(closed).toContain('title="Editor-Werkzeuge öffnen"');
		expect(closed).toContain('aria-label="Editor-Werkzeuge"');
		expect(closed).not.toContain("Open editor tools");
		const open = render(true);
		expect(open).toContain('aria-label="Editor-Werkzeuge schließen"');
		expect(open).toContain('title="Editor-Werkzeuge schließen"');
		expect(open).not.toContain("Close editor tools");
	});
});
