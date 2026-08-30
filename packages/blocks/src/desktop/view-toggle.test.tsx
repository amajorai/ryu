import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryViewToggle, ViewToggle } from "./view-toggle.tsx";

describe("view toggles", () => {
	test("only renders Showcase when the surface supports it", () => {
		const standard = renderToStaticMarkup(
			<ViewToggle onChange={() => undefined} value="grid" />
		);
		const showcase = renderToStaticMarkup(
			<ViewToggle onChange={() => undefined} showShowcase value="showcase" />
		);

		expect(standard).not.toContain("Showcase view");
		expect(showcase).toContain('aria-label="Showcase view"');
		expect(showcase).toContain('aria-pressed="true"');
	});

	test("can combine Showcase and Relations in the Library control", () => {
		const html = renderToStaticMarkup(
			<LibraryViewToggle
				onChange={() => undefined}
				showGraph
				showShowcase
				value="graph"
			/>
		);

		expect(html).toContain('aria-label="Showcase view"');
		expect(html).toContain('aria-label="Relations view"');
		expect(html).toContain('aria-pressed="true"');
	});
});
