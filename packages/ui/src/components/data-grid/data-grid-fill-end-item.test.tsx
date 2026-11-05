import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	DataGridFillEndLabel,
	gridInlineDirection,
} from "./data-grid-fill-end-item.tsx";

/** A stand-in grid element whose nearest `[dir]` ancestor carries `dir`. */
function gridElementWithDir(dir: string | null): Element {
	const ancestor = { getAttribute: () => dir };
	return {
		closest: (selector: string) =>
			selector === "[dir]" && dir !== null ? ancestor : null,
	} as unknown as Element;
}

describe("DataGridFillEndLabel", () => {
	test("keeps 'Fill right' with a right-pointing icon left-to-right", () => {
		const html = renderToStaticMarkup(<DataGridFillEndLabel dir="ltr" />);
		expect(html).toContain("Fill right");
		expect(html).not.toContain("Fill left");
		expect(html).toContain('data-fill-icon="right"');
		expect(html).toContain("lucide-arrow-right-to-line");
	});

	test("says 'Fill left' with a left-pointing icon right-to-left", () => {
		const html = renderToStaticMarkup(<DataGridFillEndLabel dir="rtl" />);
		expect(html).toContain("Fill left");
		expect(html).not.toContain("Fill right");
		expect(html).toContain('data-fill-icon="left"');
		expect(html).toContain("lucide-arrow-left-to-line");
	});
});

describe("gridInlineDirection", () => {
	test("prefers the grid's own dir over the ambient direction", () => {
		expect(gridInlineDirection(gridElementWithDir("rtl"), "ltr")).toBe("rtl");
		expect(gridInlineDirection(gridElementWithDir("ltr"), "rtl")).toBe("ltr");
	});

	test("falls back to the ambient direction without a usable dir", () => {
		expect(gridInlineDirection(null, "rtl")).toBe("rtl");
		expect(gridInlineDirection(gridElementWithDir(null), "rtl")).toBe("rtl");
		expect(gridInlineDirection(gridElementWithDir("auto"), "ltr")).toBe("ltr");
	});
});
