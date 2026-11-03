import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { useSlider } = await import("@ryu/ui/hooks/use-slider.ts");
const { isRtlTrack, ratioFromPointer, strideForKey } = await import(
	"@ryu/ui/hooks/use-slider-direction.ts"
);

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const TRACK = { left: 100, right: 300, width: 200 };

function Probe({ onChange }: { onChange: (value: number) => void }) {
	const { trackProps, sliderProps } = useSlider({
		defaultValue: 50,
		onValueChange: onChange,
	});
	return createElement(
		"div",
		{ ...trackProps, "data-testid": "track" },
		createElement("div", { ...sliderProps })
	);
}

async function mount(dir: "ltr" | "rtl") {
	const values: number[] = [];
	const host = document.createElement("div");
	host.setAttribute("dir", dir);
	// happy-dom has no UA stylesheet mapping `dir` to `direction`.
	host.style.direction = dir;
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			createElement(
				DirectionProvider,
				{ direction: dir },
				createElement(Probe, { onChange: (value) => values.push(value) })
			)
		);
	});
	const track = host.querySelector<HTMLElement>('[data-testid="track"]');
	const slider = host.querySelector<HTMLElement>('[role="slider"]');
	if (!(track && slider)) {
		throw new Error("slider did not render");
	}
	track.getBoundingClientRect = () =>
		({ ...TRACK, top: 0, bottom: 20, height: 20, x: 100, y: 0 }) as DOMRect;
	const pointerDown = async (clientX: number) => {
		await act(async () => {
			track.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					clientX,
					pointerId: 1,
				})
			);
		});
	};
	const press = async (key: string) => {
		await act(async () => {
			slider.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key })
			);
		});
	};
	const unmount = async () => {
		await act(async () => root.unmount());
		host.remove();
	};
	return { values, pointerDown, press, unmount };
}

describe("useSlider under RTL", () => {
	test("a pointer at the physical right edge yields min and the left edge max", async () => {
		const slider = await mount("rtl");
		await slider.pointerDown(TRACK.right);
		await slider.pointerDown(TRACK.left);
		expect(slider.values).toEqual([0, 100]);
		await slider.unmount();
	});

	test("ArrowLeft increases and ArrowRight decreases the value", async () => {
		const slider = await mount("rtl");
		await slider.press("ArrowLeft");
		await slider.press("ArrowRight");
		await slider.press("ArrowUp");
		expect(slider.values).toEqual([51, 50, 51]);
		await slider.unmount();
	});
});

describe("useSlider under LTR", () => {
	test("pointer and arrow keys keep their left-to-right meaning", async () => {
		const slider = await mount("ltr");
		await slider.pointerDown(TRACK.right);
		await slider.pointerDown(TRACK.left + TRACK.width / 4);
		await slider.press("ArrowRight");
		await slider.press("ArrowLeft");
		expect(slider.values).toEqual([100, 25, 26, 25]);
		await slider.unmount();
	});

	test("keys the slider does not own pass through", async () => {
		const slider = await mount("ltr");
		await slider.press("Tab");
		await slider.press("a");
		expect(slider.values).toEqual([]);
		await slider.unmount();
	});
});

describe("slider direction helpers", () => {
	test("ratioFromPointer measures from the inline start and clamps", () => {
		expect(ratioFromPointer(TRACK, 150, false)).toBe(0.25);
		expect(ratioFromPointer(TRACK, 150, true)).toBe(0.75);
		expect(ratioFromPointer(TRACK, 500, true)).toBe(0);
		expect(ratioFromPointer(TRACK, 0, true)).toBe(1);
		expect(ratioFromPointer({ ...TRACK, width: 0 }, 150, false)).toBe(0);
	});

	test("strideForKey mirrors only the horizontal arrows", () => {
		expect(strideForKey("ArrowRight", false)).toBe(1);
		expect(strideForKey("ArrowRight", true)).toBe(-1);
		expect(strideForKey("ArrowLeft", true)).toBe(1);
		expect(strideForKey("ArrowUp", true)).toBe(1);
		expect(strideForKey("ArrowDown", true)).toBe(-1);
		expect(strideForKey("Home", true)).toBe(0);
	});

	test("isRtlTrack falls back to the context direction without an element", () => {
		expect(isRtlTrack(null, "rtl")).toBe(true);
		expect(isRtlTrack(undefined)).toBe(false);
	});

	test("isRtlTrack trusts the element's computed direction over the context", () => {
		const el = document.createElement("div");
		el.style.direction = "rtl";
		document.body.append(el);
		expect(isRtlTrack(el, "ltr")).toBe(true);
		el.style.direction = "ltr";
		expect(isRtlTrack(el, "rtl")).toBe(false);
		el.remove();
	});
});
