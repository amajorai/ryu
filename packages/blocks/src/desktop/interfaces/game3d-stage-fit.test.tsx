import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const fiber = await import("@react-three/fiber");
const { ...three } = await import("three");
fiber.extend(three as unknown as Parameters<typeof fiber.extend>[0]);
const { fitBoxes, plateFitBox } = await import("./game3d-plates.ts");
const { declutterPlates, holdPlateRoots, IsoCamera, IsoStage, plateFit } =
	await import("./game3d-stage.tsx");

afterAll(() => {
	GlobalRegistrator.unregister();
});

interface Rect {
	height: number;
	left: number;
	top: number;
	width: number;
}
const domRect = ({ height, left, top, width }: Rect) =>
	({
		bottom: top + height,
		height,
		left,
		right: left + width,
		top,
		width,
		x: left,
		y: top,
	}) as DOMRect;

/** Gives `element` a layout box: `rect`, moved by its own `translate`. */
function place(element: HTMLElement, rect: Rect) {
	element.getBoundingClientRect = () => {
		// happy-dom has no `translate` until one is written.
		const nudge: string = element.style.translate ?? "";
		const [x = "0", y = "0"] = nudge.split(" ");
		return domRect({
			...rect,
			left: rect.left + (Number.parseFloat(x) || 0),
			top: rect.top + (Number.parseFloat(y) || 0),
		});
	};
	Object.defineProperty(element, "offsetParent", {
		configurable: true,
		get: () => element.parentElement,
	});
}

function stageWith(...plates: Rect[]) {
	const stage = document.createElement("div");
	stage.dataset.testid = "iso-stage";
	place(stage, { height: 600, left: 0, top: 0, width: 800 });
	const elements = plates.map((rect, index) => {
		const plate = document.createElement("div");
		plate.dataset.isoPlate = "";
		plate.textContent = `Plate ${index}`;
		place(plate, rect);
		stage.append(plate);
		return plate;
	});
	document.body.append(stage);
	return { elements, stage };
}

describe("separation passes", () => {
	test("a pass that moves is followed by one that measures and confirms", () => {
		const { elements, stage } = stageWith(
			{ height: 28, left: 300, top: 300, width: 80 },
			{ height: 28, left: 300, top: 300, width: 80 }
		);
		expect(declutterPlates(stage, true)).toBe(true);
		const reads = { count: 0 };
		for (const plate of elements) {
			const read = plate.getBoundingClientRect;
			plate.getBoundingClientRect = () => {
				reads.count += 1;
				return read();
			};
		}
		// Nothing about the plates' anchors or words changed, but the first
		// pass moved them: the second measures where they now are.
		expect(declutterPlates(stage, true)).toBe(false);
		expect(reads.count).toBeGreaterThan(0);
		const [a, b] = elements.map((plate) => plate.getBoundingClientRect());
		expect(Math.abs((b?.top ?? 0) - (a?.top ?? 0))).toBeGreaterThanOrEqual(28);
		stage.remove();
	});
});

describe("sliding nudges", () => {
	test("an animated pass waits while a nudge is still sliding", () => {
		const { elements, stage } = stageWith(
			{ height: 28, left: 300, top: 300, width: 80 },
			{ height: 28, left: 300, top: 300, width: 80 }
		);
		expect(declutterPlates(stage, false)).toBe(true);
		const [first] = elements;
		const reads = { count: 0 };
		const read = first?.getBoundingClientRect.bind(first);
		if (first && read) {
			first.getBoundingClientRect = () => {
				reads.count += 1;
				return read();
			};
		}
		// The computed translate: where each plate's nudge has got to.
		const computed = window.getComputedStyle;
		const at = (sliding: boolean) =>
			((element: Element) =>
				elements.includes(element as HTMLDivElement)
					? ({
							translate:
								sliding && element === first
									? "0px 3px"
									: (element as HTMLElement).style.translate,
						} as CSSStyleDeclaration)
					: computed(element)) as typeof window.getComputedStyle;
		// Mid-slide: the first is not yet where it was set.
		window.getComputedStyle = at(true);
		// Something changed (its words), so the pass would measure, but waits.
		if (first) {
			first.textContent = "Plate 0 again";
		}
		expect(declutterPlates(stage, false)).toBe(true);
		expect(reads.count).toBe(0);
		// Landed: the pass measures.
		window.getComputedStyle = at(false);
		declutterPlates(stage, false);
		expect(reads.count).toBeGreaterThan(0);
		window.getComputedStyle = computed;
		stage.remove();
	});
});

describe("estimated figures", () => {
	test("an alarm keeps off the figure under a name plate with no probes", () => {
		const { elements, stage } = stageWith(
			// A game's own creature: its name plate, the figure below it.
			{ height: 24, left: 300, top: 200, width: 60 },
			// An alarm sitting on that figure's estimated box.
			{ height: 24, left: 300, top: 240, width: 80 }
		);
		const [name, alarm] = elements;
		if (!(name && alarm)) {
			throw new Error("no plates");
		}
		name.dataset.actAgent = "gu";
		delete alarm.dataset.isoPlate;
		alarm.dataset.isoTarget = "";
		alarm.dataset.actTarget = "alarm";
		declutterPlates(stage, true);
		const figure = { bottom: 224 + 60, left: 300, right: 360, top: 224 };
		const box = alarm.getBoundingClientRect();
		const clear =
			box.top >= figure.bottom ||
			box.bottom <= figure.top ||
			box.left >= figure.right ||
			box.right <= figure.left;
		expect(clear).toBe(true);
		// The name plate itself stays put.
		expect(name.getBoundingClientRect().top).toBe(200);
		stage.remove();
	});
});

describe("plate roots", () => {
	test("drei's roots stop transitioning; the centring wrapper is left alone", () => {
		const stage = document.createElement("div");
		const root = document.createElement("div");
		root.style.transform = "translate3d(120px, 80px, 0px)";
		const wrapper = document.createElement("div");
		wrapper.style.transform = "translate3d(-50%, -50%, 0px)";
		const plate = document.createElement("div");
		plate.dataset.isoPlate = "";
		wrapper.append(plate);
		root.append(wrapper);
		stage.append(root);
		holdPlateRoots(stage);
		expect(root.style.transition).toBe("none");
		expect(wrapper.style.transition).toBe("");
	});
});

describe("content fit", () => {
	test("anchors a side-hung plate at drei's root, not at its own centre", () => {
		const stage = document.createElement("div");
		const root = document.createElement("div");
		root.style.transform = "translate3d(100px, 300px, 0px)";
		place(root, { height: 0, left: 100, top: 300, width: 0 });
		const plate = document.createElement("div");
		plate.dataset.isoTarget = "alarm";
		// Hung right of its anchor, as an alarm plate is.
		const own = { height: 24, left: 108, top: 288, width: 120 };
		place(plate, own);
		root.append(plate);
		stage.append(root);
		document.body.append(stage);
		const canvas = domRect({ height: 844, left: 0, top: 0, width: 390 });
		const insets = { bottom: 80, left: 0, right: 0, top: 70 };
		const pad = { above: 1, below: 0.5, max: 2, side: 0.5 };
		const room = { height: 844, insets, width: 390 };
		const box = (anchor: [number, number] | null) =>
			plateFitBox({
				anchor,
				canvas,
				nudge: [0, 0],
				plate: domRect(own),
				reach: domRect(own),
			});
		// Through another camera's view (a zoom about the stage's centre),
		// where the anchor choice shows.
		const toView = (points: [number, number][]) =>
			points.map(([x, y]): [number, number] => [
				195 + (x - 195) / 1.4,
				422 + (y - 422) / 1.4,
			]);
		const unfitted = { right: 0, scale: 1, up: 0 };
		const fit = plateFit(stage, canvas, insets, 20, pad, unfitted, toView);
		const anchored = fitBoxes(
			[box([100, 300])],
			room,
			20,
			pad,
			unfitted,
			toView
		);
		const centred = fitBoxes([box(null)], room, 20, pad, unfitted, toView);
		expect(fit?.right).toBeCloseTo(anchored?.right ?? 0, 6);
		expect(fit?.up).toBeCloseTo(anchored?.up ?? 0, 6);
		expect(Math.abs((fit?.right ?? 0) - (centred?.right ?? 0))).toBeGreaterThan(
			0.1
		);
		stage.remove();
	});
});

const BOUNDS = { maxX: 5, maxZ: 5, minX: -5, minZ: -5 };

describe("data-iso-fit", () => {
	test("pending from the first render; none with no WebGL", async () => {
		const stage = (
			<IsoStage
				bounds={BOUNDS}
				fallback={<p>No 3D here</p>}
				label="Test stage"
				night={false}
				reducedMotion
			>
				{() => null}
			</IsoStage>
		);
		expect(renderToStaticMarkup(stage)).toContain('data-iso-fit="pending"');
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(stage);
		});
		// happy-dom has no WebGL: the fallback stage has nothing to settle.
		expect(
			container.querySelector<HTMLElement>("[data-iso-fit]")?.dataset.isoFit
		).toBe("none");
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	test("goes back to pending when the base fit (insets) changes", async () => {
		const stage = document.createElement("div");
		stage.dataset.testid = "iso-stage";
		const canvas = document.createElement("canvas");
		stage.append(canvas);
		document.body.append(stage);
		const noop = () => undefined;
		const root = fiber.createRoot(canvas);
		await root.configure({
			events: undefined,
			frameloop: "never",
			gl: {
				domElement: canvas,
				getPixelRatio: () => 1,
				render: noop,
				setPixelRatio: noop,
				setSize: noop,
				shadowMap: { enabled: false },
				xr: {
					addEventListener: noop,
					enabled: false,
					isPresenting: false,
					removeEventListener: noop,
					setAnimationLoop: noop,
				},
			} as never,
			orthographic: true,
			size: { height: 600, left: 0, top: 0, width: 800 },
		});
		const camera = (top: number) => (
			<IsoCamera
				bounds={BOUNDS}
				fill={1}
				focusZoom={1.45}
				insets={{ bottom: 0, left: 0, right: 0, top }}
				reducedMotion
			/>
		);
		await act(async () => {
			root.render(camera(40));
		});
		expect(stage.dataset.isoFit).toBe("pending");
		// Say it settled; new insets move the base camera: pending again.
		stage.dataset.isoFit = "done";
		await act(async () => {
			root.render(camera(90));
		});
		expect(stage.dataset.isoFit).toBe("pending");
		await act(async () => {
			root.unmount();
		});
		stage.remove();
	});
});
