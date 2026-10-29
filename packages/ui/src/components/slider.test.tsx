import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Slider } from "./slider.tsx";

describe("Slider accessible thumb labels", () => {
	test("forwards the root label to a single focusable thumb", () => {
		const html = renderToStaticMarkup(
			<Slider
				aria-label="Zoom slider"
				defaultValue={[1]}
				max={3}
				min={1}
				step={0.1}
			/>
		);
		const input = html.match(/<input[^>]*type="range"[^>]*>/u)?.[0];

		expect(input).toContain('aria-label="Zoom slider"');
	});

	test("gives range thumbs distinct labels", () => {
		const html = renderToStaticMarkup(
			<Slider
				aria-label="Visible range"
				defaultValue={[10, 90]}
				max={100}
				min={0}
			/>
		);
		const thumbs = Array.from(
			html.matchAll(/<input[^>]*type="range"[^>]*>/gu),
			(match) => match[0]
		);

		expect(thumbs).toHaveLength(2);
		expect(thumbs[0]).toContain('aria-label="Visible range 1"');
		expect(thumbs[1]).toContain('aria-label="Visible range 2"');
	});
});
