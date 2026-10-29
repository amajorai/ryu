import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RangeSlider } from "./range-slider.tsx";

const FILL_VARIABLE = "--range-slider-1-background-color";

function moduleRule(css: string, selector: string): string {
	const start = css.indexOf(`${selector} {`);
	return start === -1 ? "" : css.slice(start, css.indexOf("}", start));
}

describe("RangeSlider", () => {
	it("keeps the neutral fill when no fillColor is set", () => {
		const html = renderToStaticMarkup(<RangeSlider />);

		expect(html).toContain("bg-foreground/15");
		expect(html).not.toContain(FILL_VARIABLE);
	});

	it("passes fillColor through the tint variable", () => {
		const html = renderToStaticMarkup(
			<RangeSlider fillColor="var(--primary)" />
		);

		expect(html).not.toContain("bg-foreground/15");
		expect(html).toContain(`${FILL_VARIABLE}:var(--primary)`);
	});

	it("keeps the tint out of the always-applied fill rule", async () => {
		// CSS modules are unlayered and outrank `bg-foreground/15`. An always-on
		// rule reading an unset tint variable would make the default fill
		// transparent, so the tint lives in its own conditional class.
		const css = await Bun.file(
			new URL("./range-slider.module.css", import.meta.url)
		).text();

		const fill = moduleRule(css, ".inline1");

		expect(fill).toContain("width");
		expect(fill).not.toContain("background");
		expect(moduleRule(css, ".fillTint")).toContain(
			`background-color: var(${FILL_VARIABLE})`
		);
	});
});
