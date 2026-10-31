import { afterEach, describe, expect, test } from "bun:test";
import { setDialogOverlayBlur } from "../hooks/use-dialog-overlay-blur.ts";

// Every modal scrim (Dialog, AlertDialog, Sheet, Drawer and the editor copies)
// is a plain solid dim: no blur, no saturate, F4 motion tokens for the fade.

const MODAL_PRIMITIVES = [
	"../components/dialog.tsx",
	"../components/alert-dialog.tsx",
	"../components/sheet.tsx",
	"../components/drawer.tsx",
	"../components/editor/ui/dialog.tsx",
	"../components/editor/ui/alert-dialog.tsx",
] as const;

const OVERLAY_CLASS_STRING = /"ryu-dialog-overlay [^"]*"/;
const BACKDROP_FILTER_CLASS = /backdrop-(blur|saturate)|backdrop-filter/;
const DIALOG_OVERLAY_RULE = /\.ryu-dialog-overlay\s*\{([^}]*)\}/;
const LIGHT_SCRIM =
	/:root\s*\{[^}]*--ryu-dialog-overlay-background:\s*rgb\(0 0 0 \/ 30%\)/;
const DARK_SCRIM =
	/\.dark,\s*\[data-ryu-theme="dark"\]\s*\{\s*--ryu-dialog-overlay-background:\s*rgb\(0 0 0 \/ 50%\)/;
const OVERLAY_APPEARANCE_MAP =
	/const dialogContentOverlayAppearance = \{([\s\S]*?)\} as const;/;

function read(relativePath: string): Promise<string> {
	return Bun.file(new URL(relativePath, import.meta.url)).text();
}

describe("modal scrim", () => {
	test("the shared overlay rule paints a solid dim and never filters the backdrop", async () => {
		const css = await read("./overlays.css");
		const rule = css.match(DIALOG_OVERLAY_RULE)?.[1] ?? "";

		expect(rule).toContain(
			"background-color: var(--ryu-dialog-overlay-background)"
		);
		expect(rule).not.toContain("backdrop-filter");
		expect(css).not.toContain("--ryu-dialog-overlay-blur");
		expect(css).toMatch(LIGHT_SCRIM);
		expect(css).toMatch(DARK_SCRIM);
	});

	for (const path of MODAL_PRIMITIVES) {
		test(`${path} fades a plain scrim with the F4 motion tokens`, async () => {
			const source = await read(path);
			const overlayClasses = source.match(OVERLAY_CLASS_STRING)?.[0] ?? "";

			expect(overlayClasses).not.toBe("");
			expect(overlayClasses).not.toMatch(BACKDROP_FILTER_CLASS);
			expect(overlayClasses).toContain("duration-(--duration-slow)");
			expect(overlayClasses).toContain("ease-(--ease-enter)");
			expect(overlayClasses).toContain("duration-(--duration-fast)");
			expect(overlayClasses).toContain("ease-(--ease-exit)");
		});
	}

	test("named dialog appearances do not restyle the scrim with a blur", async () => {
		const source = await read("../components/dialog.tsx");
		const overlayAppearances = source.match(OVERLAY_APPEARANCE_MAP)?.[1] ?? "";

		expect(overlayAppearances).not.toBe("");
		expect(overlayAppearances).not.toMatch(BACKDROP_FILTER_CLASS);
		expect(overlayAppearances).not.toContain("bg-black/");
	});
});

describe("setDialogOverlayBlur", () => {
	const originalDocument = globalThis.document;

	afterEach(() => {
		globalThis.document = originalDocument;
	});

	function stubRoot() {
		const properties = new Map<string, string>();
		const attributes = new Map<string, string>();
		const root = {
			style: {
				setProperty: (name: string, value: string) =>
					properties.set(name, value),
				removeProperty: (name: string) => properties.delete(name),
			},
			setAttribute: (name: string, value: string) =>
				attributes.set(name, value),
			removeAttribute: (name: string) => attributes.delete(name),
		};
		globalThis.document = {
			documentElement: root,
		} as unknown as Document;
		return { attributes, properties };
	}

	test("on lets the stylesheet's light or dark dim apply and sets no blur", () => {
		const { attributes, properties } = stubRoot();
		setDialogOverlayBlur(true);

		expect(properties.has("--ryu-dialog-overlay-background")).toBe(false);
		expect(properties.has("--ryu-dialog-overlay-blur")).toBe(false);
		expect(attributes.has("data-dialog-overlay-blur")).toBe(false);
	});

	test("off pins the scrim transparent and hides it", () => {
		const { attributes, properties } = stubRoot();
		setDialogOverlayBlur(false);

		expect(properties.get("--ryu-dialog-overlay-background")).toBe(
			"rgb(0 0 0 / 0)"
		);
		expect(properties.has("--ryu-dialog-overlay-blur")).toBe(false);
		expect(attributes.get("data-dialog-overlay-blur")).toBe("off");
	});
});
