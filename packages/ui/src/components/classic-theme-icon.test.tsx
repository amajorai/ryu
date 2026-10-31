import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClassicThemeIcon } from "./classic-theme-icon.tsx";

describe("ClassicThemeIcon", () => {
	it("renders decorative outline sun and moon glyphs", () => {
		const markup = renderToStaticMarkup(<ClassicThemeIcon />);

		expect(markup).toContain('aria-hidden="true"');
		expect([...markup.matchAll(/<svg/g)]).toHaveLength(2);
		expect(markup).toContain('fill="none"');
		expect(markup).not.toContain("<clipPath");
	});
});
