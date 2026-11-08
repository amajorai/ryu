/**
 * Split dividers under RTL. react-resizable-panels has no `dir` handling of
 * its own, but it orders a group's children by their laid-out `offsetLeft`
 * before pairing panels with a divider. Under `dir="rtl"` the start panel is
 * laid out on the right, so the library pairs the panels in visual order and
 * both the pointer delta and the arrow keys already resize toward the side the
 * divider moves (checked in Chromium: dragging left or pressing ArrowLeft
 * widens the start panel). These tests pin that behaviour so nobody "fixes"
 * the wrapper by negating deltas or swapping keys, which would invert it.
 *
 * happy-dom does no layout, so a tiny flex-row emulator below gives every
 * group child the box a browser would: widths from the library's `flexGrow`
 * percentages, placed from the left (ltr) or the right (rtl). It also
 * reflects `ariaDisabled`, which happy-dom leaves undefined (the library reads
 * anything but `null` as a disabled divider).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DirectionProvider } = await import("./direction.tsx");
const { ResizableHandle, ResizablePanel, ResizablePanelGroup } = await import(
	"./resizable.tsx"
);

const GROUP_WIDTH = 800;
const GROUP_HEIGHT = 200;
const SEPARATOR_WIDTH = 4;

interface Box {
	height: number;
	left: number;
	top: number;
	width: number;
}

function isRtl(element: Element): boolean {
	return element.closest("[dir]")?.getAttribute("dir") === "rtl";
}

/** Boxes for each child of a horizontal group, laid out as a flex row. */
function layoutGroup(group: HTMLElement): Map<Element, Box> {
	const children = [...group.children];
	const separators = children.filter((child) =>
		child.hasAttribute("data-separator")
	);
	const panels = children.filter((child) => child.hasAttribute("data-panel"));
	const grows = panels.map((panel) => {
		const grow = Number.parseFloat((panel as HTMLElement).style.flexGrow);
		return Number.isFinite(grow) ? grow : 1;
	});
	const totalGrow = grows.reduce((sum, grow) => sum + grow, 0) || 1;
	const free = GROUP_WIDTH - separators.length * SEPARATOR_WIDTH;
	const rtl = isRtl(group);
	const boxes = new Map<Element, Box>();
	let cursor = 0;
	for (const child of children) {
		const panelIndex = panels.indexOf(child);
		const grow = grows[panelIndex] ?? 0;
		const width =
			panelIndex === -1 ? SEPARATOR_WIDTH : (free * grow) / totalGrow;
		const left = rtl ? GROUP_WIDTH - cursor - width : cursor;
		boxes.set(child, { height: GROUP_HEIGHT, left, top: 0, width });
		cursor += width;
	}
	return boxes;
}

function boxOf(element: Element): Box {
	if (element.hasAttribute("data-group")) {
		return { height: GROUP_HEIGHT, left: 0, top: 0, width: GROUP_WIDTH };
	}
	const group = element.closest("[data-group]");
	if (group instanceof HTMLElement && element.parentElement === group) {
		return (
			layoutGroup(group).get(element) ?? {
				height: 0,
				left: 0,
				top: 0,
				width: 0,
			}
		);
	}
	const parent = element.parentElement;
	return parent
		? boxOf(parent)
		: { height: GROUP_HEIGHT, left: 0, top: 0, width: GROUP_WIDTH };
}

const proto = HTMLElement.prototype;
const saved = {
	ariaDisabled: Object.getOwnPropertyDescriptor(
		Element.prototype,
		"ariaDisabled"
	),
	getBoundingClientRect: Object.getOwnPropertyDescriptor(
		Element.prototype,
		"getBoundingClientRect"
	),
	offsetHeight: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
	offsetLeft: Object.getOwnPropertyDescriptor(proto, "offsetLeft"),
	offsetTop: Object.getOwnPropertyDescriptor(proto, "offsetTop"),
	offsetWidth: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
};

beforeAll(() => {
	Object.defineProperty(Element.prototype, "ariaDisabled", {
		configurable: true,
		get(this: Element) {
			return this.getAttribute("aria-disabled");
		},
	});
	Object.defineProperty(Element.prototype, "getBoundingClientRect", {
		configurable: true,
		value(this: Element) {
			const { height, left, top, width } = boxOf(this);
			return new DOMRect(left, top, width, height);
		},
	});
	const getters: Record<string, (box: Box) => number> = {
		offsetHeight: (box) => box.height,
		offsetLeft: (box) => box.left,
		offsetTop: (box) => box.top,
		offsetWidth: (box) => box.width,
	};
	for (const [name, read] of Object.entries(getters)) {
		Object.defineProperty(proto, name, {
			configurable: true,
			get(this: HTMLElement) {
				return read(boxOf(this));
			},
		});
	}
});

afterAll(async () => {
	for (const [name, descriptor] of Object.entries(saved)) {
		if (descriptor) {
			Object.defineProperty(
				name === "getBoundingClientRect" || name === "ariaDisabled"
					? Element.prototype
					: proto,
				name,
				descriptor
			);
		}
	}
	await GlobalRegistrator.unregister();
});

type Direction = "ltr" | "rtl";

async function mountSplit(direction: Direction) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<DirectionProvider direction={direction}>
				<div dir={direction}>
					<ResizablePanelGroup orientation="horizontal">
						<ResizablePanel defaultSize="30%" id="start" minSize="10%">
							start
						</ResizablePanel>
						<ResizableHandle id="divider" />
						<ResizablePanel id="end" minSize="10%">
							end
						</ResizablePanel>
					</ResizablePanelGroup>
				</div>
			</DirectionProvider>
		);
	});
	const start = host.querySelector<HTMLElement>("#start");
	const divider = host.querySelector<HTMLElement>("#divider");
	if (!(start && divider)) {
		throw new Error("split did not render");
	}
	const startWidth = () => start.getBoundingClientRect().width;
	const unmount = async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	};
	return { divider, startWidth, unmount };
}

async function pressKey(divider: HTMLElement, key: string) {
	await act(async () => {
		divider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

/** Drags the divider by `dx` physical pixels (negative is leftward). */
async function dragBy(divider: HTMLElement, dx: number) {
	const rect = divider.getBoundingClientRect();
	const x = rect.left + rect.width / 2;
	const y = rect.top + rect.height / 2;
	const init = { bubbles: true, button: 0, pointerType: "mouse" };
	await act(async () => {
		divider.dispatchEvent(
			new PointerEvent("pointerdown", {
				...init,
				buttons: 1,
				clientX: x,
				clientY: y,
			})
		);
		document.dispatchEvent(
			new PointerEvent("pointermove", {
				...init,
				buttons: 1,
				clientX: x + dx,
				clientY: y,
			})
		);
		document.dispatchEvent(
			new PointerEvent("pointerup", {
				...init,
				buttons: 0,
				clientX: x + dx,
				clientY: y,
			})
		);
	});
}

describe("ResizablePanelGroup reading direction", () => {
	test("LTR: ArrowRight widens the start panel and ArrowLeft narrows it", async () => {
		const split = await mountSplit("ltr");
		const before = split.startWidth();
		await pressKey(split.divider, "ArrowRight");
		const widened = split.startWidth();
		expect(widened).toBeGreaterThan(before);
		await pressKey(split.divider, "ArrowLeft");
		expect(split.startWidth()).toBeLessThan(widened);
		await split.unmount();
	});

	test("RTL: ArrowLeft (toward the inline end) widens the start panel", async () => {
		const split = await mountSplit("rtl");
		const before = split.startWidth();
		await pressKey(split.divider, "ArrowLeft");
		const widened = split.startWidth();
		expect(widened).toBeGreaterThan(before);
		await pressKey(split.divider, "ArrowRight");
		expect(split.startWidth()).toBeLessThan(widened);
		await split.unmount();
	});

	test("LTR: dragging the divider right widens the start panel", async () => {
		const split = await mountSplit("ltr");
		const before = split.startWidth();
		await dragBy(split.divider, 100);
		expect(split.startWidth()).toBeGreaterThan(before);
		await split.unmount();
	});

	test("RTL: dragging the divider left (toward the inline end) widens the start panel", async () => {
		const split = await mountSplit("rtl");
		const before = split.startWidth();
		await dragBy(split.divider, -100);
		expect(split.startWidth()).toBeGreaterThan(before);
		await split.unmount();
	});

	test("RTL: dragging the divider right narrows the start panel", async () => {
		const split = await mountSplit("rtl");
		const before = split.startWidth();
		await dragBy(split.divider, 100);
		expect(split.startWidth()).toBeLessThan(before);
		await split.unmount();
	});
});
