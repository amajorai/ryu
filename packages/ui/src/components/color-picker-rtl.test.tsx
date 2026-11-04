import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("./direction.tsx");
const { ColorPicker, ColorPickerContent, ColorPickerPanel } = await import(
	"./color-picker.tsx"
);

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const TRACK_WIDTH = 360;

function picker(onValueChange?: (value: string) => void) {
	return (
		<ColorPicker
			defaultValue="#ff0000"
			format="hex"
			inline
			onValueChange={onValueChange}
		>
			<ColorPickerContent>
				<ColorPickerPanel />
			</ColorPickerContent>
		</ColorPicker>
	);
}

function sliderRootTag(html: string, slot: string): string {
	const tag = html.match(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`))?.[0];
	if (!tag) {
		throw new Error(`no ${slot} in markup`);
	}
	return tag;
}

test("hue and alpha sliders stay physical LTR inside an RTL direction context", () => {
	const html = renderToStaticMarkup(
		<div dir="rtl">
			<DirectionProvider direction="rtl">{picker()}</DirectionProvider>
		</div>
	);
	for (const slot of ["color-picker-hue-slider", "color-picker-alpha-slider"]) {
		expect(sliderRootTag(html, slot)).toContain('dir="ltr"');
	}
	// The painted spectrum runs left to right, matching the forced direction.
	expect(html).toContain("bg-[linear-gradient(to_right,#ff0000_0%");
});

function stubRect(element: Element, width: number) {
	element.getBoundingClientRect = () =>
		({
			bottom: 12,
			height: 12,
			left: 0,
			right: width,
			top: 0,
			width,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		}) as DOMRect;
}

async function renderInRtlDocument(
	withProvider: boolean,
	onValueChange: (value: string) => void
) {
	document.documentElement.dir = "rtl";
	const host = document.createElement("div");
	host.dir = "rtl";
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			withProvider ? (
				<DirectionProvider direction="rtl">
					{picker(onValueChange)}
				</DirectionProvider>
			) : (
				picker(onValueChange)
			)
		);
	});
	const cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
		document.documentElement.dir = "";
	};
	return { host, cleanup };
}

for (const withProvider of [true, false]) {
	const label = withProvider
		? "under DirectionProvider rtl"
		: "under html dir=rtl with no provider";

	test(`a pointer 10% from the left picks hue 36 ${label}`, async () => {
		const values: string[] = [];
		const { host, cleanup } = await renderInRtlDocument(withProvider, (v) =>
			values.push(v)
		);
		const hueRoot = host.querySelector('[data-slot="color-picker-hue-slider"]');
		const control = hueRoot?.firstElementChild;
		expect(hueRoot?.getAttribute("dir")).toBe("ltr");
		expect(control).toBeTruthy();
		if (!control) {
			await cleanup();
			return;
		}
		stubRect(control, TRACK_WIDTH);
		for (const thumb of control.querySelectorAll("*")) {
			stubRect(thumb, 0);
		}

		await act(async () => {
			control.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					button: 0,
					clientX: TRACK_WIDTH * 0.1,
					clientY: 6,
					pointerId: 1,
					pointerType: "mouse",
				})
			);
		});

		const thumbInput = host.querySelector<HTMLInputElement>(
			'[data-slot="color-picker-hue-slider"] input[type="range"]'
		);
		expect(Number(thumbInput?.value)).toBe(36);
		// Hue 36 at full saturation and value is #FF9900, not hue 324 (#FF0099).
		expect(values.at(-1)?.toUpperCase()).toBe("#FF9900");
		await cleanup();
	});

	test(`ArrowRight raises the hue ${label}`, async () => {
		const { host, cleanup } = await renderInRtlDocument(
			withProvider,
			() => undefined
		);
		const thumbInput = host.querySelector<HTMLInputElement>(
			'[data-slot="color-picker-hue-slider"] input[type="range"]'
		);
		expect(thumbInput).toBeTruthy();
		await act(async () => {
			thumbInput?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
		expect(Number(thumbInput?.value)).toBe(1);
		await cleanup();
	});
}
