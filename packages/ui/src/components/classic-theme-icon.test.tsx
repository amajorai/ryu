import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClassicThemeIcon } from "./classic-theme-icon.tsx";

describe("ClassicThemeIcon", () => {
	it("renders a decorative SVG with unique clip paths", () => {
		const markup = renderToStaticMarkup(
			<>
				<ClassicThemeIcon />
				<ClassicThemeIcon />
			</>
		);
		const clipPathIds = [...markup.matchAll(/<clipPath id="([^"]+)"/g)].map(
			([, id]) => id
		);
		const clipPathReferences = [
			...markup.matchAll(/clip-path="url\(#([^"]+)\)"/g),
		].map(([, id]) => id);

		expect(markup).toContain('aria-hidden="true"');
		expect(clipPathIds).toHaveLength(2);
		expect(new Set(clipPathIds).size).toBe(2);
		expect(clipPathReferences).toEqual(clipPathIds);
	});
});
