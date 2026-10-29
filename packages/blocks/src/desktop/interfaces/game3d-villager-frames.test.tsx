import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Plates are drei `Html` overlays (DOM); this test watches frames only.
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({ ...drei, Html: () => null }));

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { _roots, advance, createRoot, extend } = await import(
	"@react-three/fiber"
);
// What <Canvas> does for its scene: every three class as an element.
const { ...three } = await import("three");
extend(three as unknown as Parameters<typeof extend>[0]);
const { agentSwatches } = await import("./game3d-palette.ts");
const { Villagers, villagerLooksFor } = await import("./game3d-villager.tsx");

afterAll(() => {
	GlobalRegistrator.unregister();
});

/** A renderer that draws nothing: R3F runs its frames, no WebGL needed. */
function nullRenderer(canvas: HTMLCanvasElement) {
	const noop = () => undefined;
	return {
		domElement: canvas,
		getPixelRatio: () => 1,
		info: { render: {} },
		outputColorSpace: "srgb",
		render: noop,
		setPixelRatio: noop,
		setSize: noop,
		shadowMap: { enabled: false, needsUpdate: false, type: 0 },
		toneMapping: 0,
		xr: {
			addEventListener: noop,
			enabled: false,
			isPresenting: false,
			removeEventListener: noop,
			setAnimationLoop: noop,
		},
	};
}

type Spot = [number, number, number];

/**
 * Villagers on an R3F root that draws nothing, with a demand loop run by
 * hand: a frame is drawn only when the scene asked for one (invalidate).
 */
async function demandStage() {
	const canvas = document.createElement("canvas");
	const root = createRoot(canvas);
	await root.configure({
		events: undefined,
		frameloop: "never",
		gl: nullRenderer(canvas) as never,
		size: { height: 600, left: 0, top: 0, width: 800 },
	});
	const swatches = agentSwatches(["ada", "bo"]);
	const looks = (id: string) => {
		const swatch = swatches.get(id);
		if (!swatch) {
			throw new Error("no swatch");
		}
		return villagerLooksFor(id, swatch);
	};
	const walker = (key: string, to: Spot) => ({
		id: "ada",
		label: "Ada",
		life: { key, steps: [{ direct: true, do: "goTo" as const, to }] },
		looks: looks("ada"),
		name: "Ada",
		pose: "working" as const,
		position: [0, 0, 0] as Spot,
	});
	const stroller = {
		id: "bo",
		label: "Bo",
		looks: looks("bo"),
		name: "Bo",
		pose: "idle" as const,
		position: [2, 0, 2] as Spot,
		walk: [
			[2, 0, 2],
			[5, 0, 2],
			[5, 0, 5],
		] as Spot[],
	};
	const show = async (villagers: readonly unknown[]) => {
		await act(async () => {
			root.render(
				<Villagers
					plates={false}
					reducedMotion={false}
					villagers={villagers as never}
				/>
			);
		});
	};
	await show([]);
	let asked = 0;
	const store = _roots.get(canvas)?.store;
	if (!store) {
		throw new Error("no root");
	}
	await act(async () => {
		store.setState({
			invalidate: () => {
				asked += 1;
			},
		});
	});
	// R3F's clock (s); a frame-loop change restarts it at 0.
	let time = 100;
	const run = {
		busy: 0,
		frames: 0,
	};
	/** Draws while frames are asked for (up to `limit`), counting them. */
	const draw = (limit = 3000) => {
		run.busy = 0;
		run.frames = 0;
		asked = Math.max(asked, 1);
		while (asked > 0 && run.frames < limit) {
			asked = 0;
			time += 1 / 30;
			advance(time, true, store.getState());
			run.frames += 1;
			if (canvas.dataset.lifeBusy !== "0") {
				run.busy += 1;
			}
		}
		return run;
	};
	return {
		asked: () => asked,
		busy: () => canvas.dataset.lifeBusy,
		draw,
		/** Draws exactly `count` frames, asked for or not. */
		drawFrames(count: number) {
			for (let frame = 0; frame < count; frame++) {
				time += 1 / 30;
				advance(time, true, store.getState());
			}
		},
		restartClock() {
			time = 0.5;
		},
		show,
		stroller,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
		},
		walker,
	};
}

describe("villagers on a demand canvas", () => {
	test("a walk asks for frames until it ends, then one more, then idles", async () => {
		const stage = await demandStage();
		await stage.show([stage.walker("start", [0, 0, 0])]);
		// The first frame seeds the villager, settled at its script's end.
		stage.draw(10);
		expect(stage.busy()).toBe("0");
		await stage.show([stage.walker("walk", [6, 0, 0])]);
		const { busy, frames } = stage.draw();
		// 6 units at a walking pace: well over a second of frames, all asked
		// for by the walk itself, plus the frame that starts it and the one
		// after it ends.
		expect(busy).toBeGreaterThan(30);
		expect(frames).toBe(busy + 2);
		expect(stage.busy()).toBe("0");
		expect(stage.asked()).toBe(0);
		await stage.unmount();
	});

	test("a strolling villager never counts as busy, so the canvas idles", async () => {
		const stage = await demandStage();
		await stage.show([stage.stroller]);
		const { busy, frames } = stage.draw();
		expect(busy).toBe(0);
		expect(frames).toBeLessThan(5);
		expect(stage.asked()).toBe(0);
		await stage.unmount();
	});

	test("a villager removed mid-walk stops the loop", async () => {
		const stage = await demandStage();
		await stage.show([stage.walker("start", [0, 0, 0]), stage.stroller]);
		stage.draw(10);
		await stage.show([stage.walker("walk", [6, 0, 0]), stage.stroller]);
		stage.drawFrames(10);
		expect(stage.busy()).toBe("1");
		await stage.show([stage.stroller]);
		const { frames } = stage.draw();
		expect(frames).toBeLessThan(5);
		expect(stage.busy()).toBe("0");
		await stage.unmount();
	});

	test("a frame-loop change (R3F's clock restarts) neither restarts nor stalls a walk", async () => {
		const plain = await demandStage();
		await plain.show([plain.walker("start", [0, 0, 0])]);
		plain.draw(10);
		await plain.show([plain.walker("walk", [6, 0, 0])]);
		const whole = plain.draw().busy;
		await plain.unmount();

		const stage = await demandStage();
		await stage.show([stage.walker("start", [0, 0, 0])]);
		stage.draw(10);
		await stage.show([stage.walker("walk", [6, 0, 0])]);
		stage.drawFrames(10);
		stage.restartClock();
		const { busy, frames } = stage.draw();
		// The rest of the walk, not the whole walk again (or a busy count
		// running until the old clock's time comes round).
		expect(busy).toBeLessThan(whole - 5);
		expect(busy).toBeGreaterThan(whole - 15);
		expect(frames).toBeLessThan(whole);
		expect(stage.busy()).toBe("0");
		await stage.unmount();
	});
});
