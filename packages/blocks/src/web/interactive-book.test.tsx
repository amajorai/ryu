import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PassportBook } from "./interactive-book.tsx";

test("Passport book exposes an accessible cover before interaction", () => {
	const html = renderToStaticMarkup(createElement(PassportBook));
	expect(html).toContain('aria-label="Passport interactive book"');
	expect(html).toContain('aria-label="Open Passport"');
	expect(html).toContain('data-state="closed"');
	expect(html).toContain("A safer identity layer");
	expect(html).toContain("Sealed by default");
	expect(html).toContain("Human in the loop");
	expect(html).not.toContain('aria-label="Next page"');
});
