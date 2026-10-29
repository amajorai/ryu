import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
	ColorPickerSwatches,
} from "./color-picker.tsx";

function renderPanel(defaultValue: string, swatches: string[] = []) {
	return renderToStaticMarkup(
		<ColorPicker defaultValue={defaultValue} inline swatches={swatches}>
			<ColorPickerContent>
				<ColorPickerPanel />
			</ColorPickerContent>
		</ColorPicker>
	);
}

test("rejects oversized collaborative RGB and HSL colors before rendering", () => {
	for (const prefix of ["rgb", "hsl"]) {
		const poisoned = `${prefix}(1${" ".repeat(4096)}!)`;
		const html = renderPanel(poisoned, [poisoned, "#ff3b30"]);
		expect(html).toContain('data-color-value="#FF3B30"');
		expect(html).not.toContain(poisoned);
	}
}, 2000);

test("rejects malformed tokens without discarding subsequent valid swatches", () => {
	const html = renderPanel("#000000", [
		"rgb(1..2, 0, 0)",
		"hsl(0 50 50%)",
		"rgb(1,,2,3)",
		"rgb(255 0 0)",
	]);
	const buttons = html.match(/data-slot="color-picker-swatch-button"/g) ?? [];
	expect(buttons).toHaveLength(1);
	expect(html).toContain('data-color-value="#FF0000"');
});

test("retains legacy and modern RGB HSL OKLCH colors with alpha", () => {
	for (const value of [
		"rgba(255, 0, 0, 0.5)",
		"rgb(100% 0% 0% / 50%)",
		"hsla(0deg, 100%, 50%, 0.5)",
		"hsl(0 100% 50% / 50%)",
		"oklch(63% 0.2 29deg / 50%)",
	]) {
		const html = renderPanel(value, [value]);
		expect(html.match(/data-slot="color-picker-swatch-button"/g)).toHaveLength(
			1
		);
		expect(html).toContain('aria-label="Alpha transparency percentage"');
		expect(html).toContain('value="50"');
	}
});

test("stops reading swatches after the first twelve unique valid colors", () => {
	const colors = Array.from(
		{ length: 12 },
		(_, index) => `#${index.toString(16).padStart(6, "0")}`
	);
	Object.defineProperty(colors, 12, {
		get() {
			throw new Error("Read beyond visible swatches");
		},
	});
	const html = renderToStaticMarkup(
		<ColorPicker defaultValue="#000000" inline>
			<ColorPickerSwatches colors={colors} recentColors={[]} />
		</ColorPicker>
	);
	expect(html.match(/data-slot="color-picker-swatch-button"/g)).toHaveLength(
		12
	);
});
