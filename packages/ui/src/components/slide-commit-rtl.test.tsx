import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Under dir="rtl" the grip rests at the inline start (the physical right) and
// travels toward the physical left: dragging toward the inline end commits and
// ArrowLeft advances, so the drag, keys and the label's inset all agree.
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("./direction.tsx");
const { SlideCommit } = await import("./slide-commit.tsx");
const { arrowDelta, gripOrigin, progressFromPointer, revealClip } =
	await import("./slide-commit-direction.ts");

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const WIDTH = 320;

function stubRect(element: Element, width: number) {
	element.getBoundingClientRect = () =>
		({
			bottom: 56,
			height: 56,
			left: 0,
			right: width,
			top: 0,
			width,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		}) as DOMRect;
}

async function mount(direction: "ltr" | "rtl", onConfirm: () => void) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<DirectionProvider direction={direction}>
				<SlideCommit
					keyboardSteps={4}
					label="Delete chat"
					onConfirm={onConfirm}
					width={WIDTH}
				/>
			</DirectionProvider>
		);
	});
	const slider = host.querySelector<HTMLElement>('[role="slider"]');
	const track = slider?.parentElement;
	if (!(slider && track)) {
		throw new Error("SlideCommit did not render");
	}
	stubRect(track, WIDTH);
	const cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	};
	return { host, slider, track, cleanup };
}

const press = async (slider: HTMLElement, key: string, times: number) => {
	for (let step = 0; step < times; step += 1) {
		await act(async () => {
			slider.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key })
			);
		});
	}
};

const pointer = (type: string, clientX: number) => {
	const event = new PointerEvent(type, {
		bubbles: true,
		button: 0,
		clientX,
		pointerId: 1,
	});
	// The window listeners ignore synthetic events unless they look trusted.
	Object.defineProperty(event, "isTrusted", { value: true });
	return event;
};

describe("SlideCommit under RTL", () => {
	test("renders the track right-to-left", async () => {
		const { host, cleanup } = await mount("rtl", () => undefined);
		const root = host.querySelector('[data-slot="slide-commit"]');
		expect(root?.getAttribute("dir")).toBe("rtl");
		await cleanup();
	});

	test("ArrowLeft advances to a commit and ArrowRight does not", async () => {
		let calls = 0;
		const { slider, cleanup } = await mount("rtl", () => {
			calls += 1;
		});
		await press(slider, "ArrowRight", 4);
		expect(calls).toBe(0);
		await press(slider, "ArrowLeft", 4);
		expect(calls).toBe(1);
		await cleanup();
	});

	test("dragging toward the inline end (physical left) commits", async () => {
		let calls = 0;
		const { track, cleanup } = await mount("rtl", () => {
			calls += 1;
		});
		await act(async () => {
			track.dispatchEvent(pointer("pointerdown", WIDTH - 20));
			window.dispatchEvent(pointer("pointermove", WIDTH - 20));
			window.dispatchEvent(pointer("pointermove", WIDTH / 2));
			window.dispatchEvent(pointer("pointermove", 0));
			window.dispatchEvent(pointer("pointerup", 0));
		});
		expect(calls).toBe(1);
		await cleanup();
	});

	test("dragging toward the physical right does not commit", async () => {
		let calls = 0;
		const { track, cleanup } = await mount("rtl", () => {
			calls += 1;
		});
		await act(async () => {
			track.dispatchEvent(pointer("pointerdown", 20));
			window.dispatchEvent(pointer("pointermove", 20));
			window.dispatchEvent(pointer("pointermove", WIDTH));
			window.dispatchEvent(pointer("pointerup", WIDTH));
		});
		expect(calls).toBe(0);
		await cleanup();
	});
});

describe("slide-commit direction helpers", () => {
	const track = {
		getBoundingClientRect: () =>
			({ left: 10, right: 210, width: 200 }) as DOMRect,
	};

	test("pointer progress counts from the inline start", () => {
		expect(progressFromPointer(60, track, 200, "ltr")).toBe(50);
		expect(progressFromPointer(60, track, 200, "rtl")).toBe(150);
		expect(progressFromPointer(60, null, 200, "rtl")).toBe(0);
	});

	test("arrow keys follow the reading direction; Up/Down do not", () => {
		expect(arrowDelta("ArrowRight", "ltr")).toBe(1);
		expect(arrowDelta("ArrowRight", "rtl")).toBe(-1);
		expect(arrowDelta("ArrowLeft", "rtl")).toBe(1);
		expect(arrowDelta("ArrowUp", "rtl")).toBe(1);
		expect(arrowDelta("ArrowDown", "rtl")).toBe(-1);
		expect(arrowDelta("Enter", "rtl")).toBe(0);
	});

	test("the fill reveals from the inline start", () => {
		expect(revealClip(60, 200, 24, "ltr")).toBe(
			"inset(0 140px 0 0 round 24px)"
		);
		expect(revealClip(60, 200, 24, "rtl")).toBe(
			"inset(0 0 0 140px round 24px)"
		);
		expect(gripOrigin(30, 200, "ltr")).toBe("30px 50%");
		expect(gripOrigin(30, 200, "rtl")).toBe("170px 50%");
	});
});
