import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// PlateDeclutter's frame callback, driven by hand.
interface FrameState {
	camera: { position: { x: number; y: number; z: number }; zoom: number };
	frameloop: "always" | "demand";
}
let onFrame: ((state: FrameState) => void) | null = null;
const canvas = { parentElement: { closest: () => null } };
const fiber = await import("@react-three/fiber");
mock.module("@react-three/fiber", () => ({
	...fiber,
	useFrame: (callback: (state: FrameState) => void) => {
		onFrame = callback;
	},
	useThree: (select: (state: unknown) => unknown) =>
		select({ gl: { domElement: canvas } }),
}));

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DECLUTTER_MS, PlateDeclutter } = await import("./game3d-stage.tsx");

afterAll(() => {
	GlobalRegistrator.unregister();
});

/** A page clock with timers and animation frames run by hand. */
function fakePage() {
	let now = 0;
	let next = 1;
	const timers = new Map<number, { at: number; run: () => void }>();
	const frames = new Map<number, () => void>();
	const nowSpy = spyOn(performance, "now").mockImplementation(() => now);
	const page = globalThis as unknown as Record<string, unknown>;
	const saved = [
		"setTimeout",
		"clearTimeout",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	].map((name) => [name, page[name], window[name as keyof Window]] as const);
	const install = (name: string, value: unknown) => {
		page[name] = value;
		(window as unknown as Record<string, unknown>)[name] = value;
	};
	install("setTimeout", (run: () => void, ms = 0) => {
		timers.set(next, { at: now + ms, run });
		return next++;
	});
	install("clearTimeout", (id: number) => timers.delete(id));
	install("requestAnimationFrame", (run: () => void) => {
		frames.set(next, run);
		return next++;
	});
	install("cancelAnimationFrame", (id: number) => frames.delete(id));
	return {
		/** Moves the clock on, running due timers, then pending frames. */
		advanceTo(time: number) {
			now = time;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.run();
				}
			}
			for (const [id, run] of [...frames]) {
				frames.delete(id);
				run();
			}
		},
		restore() {
			nowSpy.mockRestore();
			for (const [name, onPage, onWindow] of saved) {
				page[name] = onPage;
				(window as unknown as Record<string, unknown>)[name] = onWindow;
			}
		},
	};
}

/** Draws frames every `step` ms until `until`, then idles to `idleTo`. */
function passTimes(
	frameloop: FrameState["frameloop"],
	until: number,
	idleTo: number,
	step = 16
): number[] {
	const page = fakePage();
	const passes: number[] = [];
	let time = 0;
	canvas.parentElement.closest = () => {
		passes.push(time);
		return null;
	};
	const container = document.createElement("div");
	const root = createRoot(container);
	act(() => root.render(<PlateDeclutter reducedMotion={false} />));
	// Mounting looks the stage up once; only passes count from here.
	passes.length = 0;
	const camera = { position: { x: 1, y: 2, z: 3 }, zoom: 40 };
	try {
		for (time = 0; time <= until; time += step) {
			page.advanceTo(time);
			onFrame?.({ camera, frameloop });
		}
		for (; time <= idleTo; time += step) {
			page.advanceTo(time);
		}
	} finally {
		act(() => root.unmount());
		page.restore();
	}
	return passes;
}

describe("plate separation passes", () => {
	test("an always-drawing canvas parts once per window, never twice", () => {
		const passes = passTimes("always", 2400, 2400);
		expect(passes.length).toBeGreaterThanOrEqual(2400 / DECLUTTER_MS - 1);
		expect(passes.length).toBeLessThanOrEqual(2400 / DECLUTTER_MS + 1);
		for (const [index, at] of passes.entries()) {
			if (index > 0) {
				expect(at - (passes[index - 1] ?? 0)).toBeGreaterThanOrEqual(
					DECLUTTER_MS - 16
				);
			}
		}
	});

	test("a demand canvas that stops drawing still parts the last positions", () => {
		const passes = passTimes("demand", 100, 1000);
		const last = passes.at(-1) ?? 0;
		expect(last).toBeGreaterThan(100);
		expect(last).toBeLessThanOrEqual(DECLUTTER_MS + 16);
		// One trailing pass, not a stream of them.
		expect(passes.filter((at) => at > 100)).toHaveLength(1);
	});
});
