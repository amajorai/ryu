import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Aurora from "./aurora.tsx";

describe("Aurora", () => {
	it("renders when the browser does not provide toSorted", () => {
		const originalToSorted = Array.prototype.toSorted;
		try {
			Object.defineProperty(Array.prototype, "toSorted", {
				configurable: true,
				value: undefined,
				writable: true,
			});

			expect(() =>
				renderToStaticMarkup(<Aurora colorStops={["#00FCB9", "#FFC500"]} />)
			).not.toThrow();
		} finally {
			Object.defineProperty(Array.prototype, "toSorted", {
				configurable: true,
				value: originalToSorted,
				writable: true,
			});
		}
	});

	it("provides an animated fallback when WebGL 2 is unavailable", async () => {
		const stylesheet = await Bun.file(
			new URL("./aurora.module.css", import.meta.url)
		).text();

		expect(stylesheet).toContain("fallback::before");
		expect(stylesheet).toContain("footer-aurora-fallback-drift");
		expect(stylesheet).toContain("prefers-reduced-motion: reduce");
	});
});
