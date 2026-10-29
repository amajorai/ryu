import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	backdropPixelRatio,
	createFrameLoop,
	type FrameLoopEnv,
	isSoftwareRenderer,
	probeAcceleratedWebgl,
} from "./webgl-gate.ts";

describe("probeAcceleratedWebgl", () => {
	it("asks for the requested kind without software fallback and frees the probe", () => {
		const loseContext = mock(() => undefined);
		const calls: unknown[][] = [];
		const accelerated = probeAcceleratedWebgl("webgl2", () => ({
			// SAFETY: the probe reads only truthiness and getExtension; this fixture
			// never exposes GPU methods.
			getContext: ((...args: unknown[]) => {
				calls.push(args);
				return { getExtension: () => ({ loseContext }) };
			}) as unknown as HTMLCanvasElement["getContext"],
		}));

		expect(accelerated).toBe(true);
		expect(calls).toEqual([["webgl2", { failIfMajorPerformanceCaveat: true }]]);
		expect(loseContext).toHaveBeenCalledTimes(1);
	});

	it("reports no GPU when the context is refused or creation throws", () => {
		expect(
			probeAcceleratedWebgl("webgl", () => ({
				// SAFETY: returning null satisfies every native canvas overload;
				// the probe tests an unavailable context.
				getContext: (() => null) as HTMLCanvasElement["getContext"],
			}))
		).toBe(false);
		expect(
			probeAcceleratedWebgl("webgl", () => {
				throw new Error("blocked");
			})
		).toBe(false);
	});
});

describe("isSoftwareRenderer", () => {
	const UNMASKED_RENDERER_WEBGL = 0x92_46;
	const RENDERER = 0x1f_01;
	function fakeGl(renderer: string, unmasked: boolean) {
		return {
			RENDERER,
			getExtension: (name: string) =>
				unmasked && name === "WEBGL_debug_renderer_info"
					? { UNMASKED_RENDERER_WEBGL }
					: null,
			getParameter: (pname: number) =>
				pname === (unmasked ? UNMASKED_RENDERER_WEBGL : RENDERER)
					? renderer
					: null,
		} as unknown as Parameters<typeof isSoftwareRenderer>[0];
	}

	it("flags CPU rasterizers, including ANGLE on SwiftShader", () => {
		for (const renderer of [
			"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
			"llvmpipe (LLVM 15.0.7, 256 bits)",
			"Microsoft Basic Render Driver",
		]) {
			expect(isSoftwareRenderer(fakeGl(renderer, true))).toBe(true);
		}
	});

	it("accepts hardware renderers and falls back to the masked name", () => {
		expect(
			isSoftwareRenderer(
				fakeGl(
					"ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
					true
				)
			)
		).toBe(false);
		expect(isSoftwareRenderer(fakeGl("Mesa Intel(R) Xe Graphics", false))).toBe(
			false
		);
		expect(isSoftwareRenderer(fakeGl("SwiftShader", false))).toBe(true);
	});

	it("probes a software context as unaccelerated and still frees it", () => {
		const loseContext = mock(() => undefined);
		const accelerated = probeAcceleratedWebgl("webgl", () => ({
			// SAFETY: the probe reads getExtension and getParameter only.
			getContext: (() => ({
				RENDERER,
				getExtension: (name: string) =>
					name === "WEBGL_lose_context"
						? { loseContext }
						: { UNMASKED_RENDERER_WEBGL },
				getParameter: () => "SwiftShader driver",
			})) as unknown as HTMLCanvasElement["getContext"],
		}));
		expect(accelerated).toBe(false);
		expect(loseContext).toHaveBeenCalledTimes(1);
	});
});

describe("backdropPixelRatio", () => {
	const original = globalThis.devicePixelRatio;
	afterEach(() => {
		globalThis.devicePixelRatio = original;
	});

	it("caps the device pixel ratio", () => {
		globalThis.devicePixelRatio = 3;
		expect(backdropPixelRatio()).toBe(1.5);
		expect(backdropPixelRatio(1)).toBe(1);
		globalThis.devicePixelRatio = 1;
		expect(backdropPixelRatio()).toBe(1);
	});
});

/** A fake browser: frames run only when `flush` is called. */
function fakeEnv() {
	const frames = new Map<number, (now: number) => void>();
	let nextId = 1;
	let now = 0;
	let onScreen: ((visible: boolean) => void) | undefined;
	let onVisibility: (() => void) | undefined;
	const state = { hidden: false, observing: false, visibilityBound: false };
	const env: FrameLoopEnv = {
		cancelFrame: (id) => {
			frames.delete(id);
		},
		isHidden: () => state.hidden,
		observe: (_target, onChange) => {
			onScreen = onChange;
			state.observing = true;
			return () => {
				state.observing = false;
			};
		},
		onVisibilityChange: (listener) => {
			onVisibility = listener;
			state.visibilityBound = true;
			return () => {
				state.visibilityBound = false;
			};
		},
		requestFrame: (callback) => {
			const id = nextId++;
			frames.set(id, callback);
			return id;
		},
	};
	return {
		env,
		/** Runs the frames queued so far, as one animation frame. */
		flush: () => {
			now += 16;
			const queued = [...frames.values()];
			frames.clear();
			for (const callback of queued) {
				callback(now);
			}
		},
		pending: () => frames.size,
		setHidden: (hidden: boolean) => {
			state.hidden = hidden;
			onVisibility?.();
		},
		setOnScreen: (visible: boolean) => onScreen?.(visible),
		state,
	};
}

// SAFETY: createFrameLoop only hands the target to env.observe, which the fake ignores.
const target = {} as Element;

describe("createFrameLoop", () => {
	it("loops while on screen and pauses off screen", () => {
		const browser = fakeEnv();
		const frame = mock(() => true);
		createFrameLoop(target, frame, { env: browser.env });

		browser.flush();
		browser.flush();
		expect(frame).toHaveBeenCalledTimes(2);
		expect(browser.pending()).toBe(1);

		browser.setOnScreen(false);
		expect(browser.pending()).toBe(0);
		browser.flush();
		expect(frame).toHaveBeenCalledTimes(2);

		browser.setOnScreen(true);
		browser.flush();
		expect(frame).toHaveBeenCalledTimes(3);
		expect(browser.pending()).toBe(1);
	});

	it("halts in a hidden tab and resumes when visible", () => {
		const browser = fakeEnv();
		const frame = mock(() => true);
		createFrameLoop(target, frame, { env: browser.env });

		browser.setHidden(true);
		expect(browser.pending()).toBe(0);
		browser.flush();
		expect(frame).not.toHaveBeenCalled();

		browser.setHidden(false);
		browser.flush();
		expect(frame).toHaveBeenCalledTimes(1);
		expect(browser.pending()).toBe(1);
	});

	it("draws once per wake when still", () => {
		const browser = fakeEnv();
		const frame = mock(() => true);
		const loop = createFrameLoop(target, frame, {
			env: browser.env,
			still: true,
		});

		browser.flush();
		browser.flush();
		expect(frame).toHaveBeenCalledTimes(1);
		expect(browser.pending()).toBe(0);

		loop.wake();
		loop.wake();
		browser.flush();
		expect(frame).toHaveBeenCalledTimes(2);
	});

	it("idles when the frame returns false until woken", () => {
		const browser = fakeEnv();
		const frame = mock(() => false);
		const loop = createFrameLoop(target, frame, { env: browser.env });

		browser.flush();
		expect(browser.pending()).toBe(0);
		loop.wake();
		browser.flush();
		expect(frame).toHaveBeenCalledTimes(2);
	});

	it("stop cancels the pending frame and unsubscribes", () => {
		const browser = fakeEnv();
		const frame = mock(() => true);
		const loop = createFrameLoop(target, frame, { env: browser.env });

		loop.stop();
		expect(browser.pending()).toBe(0);
		expect(browser.state.observing).toBe(false);
		expect(browser.state.visibilityBound).toBe(false);
		loop.wake();
		browser.flush();
		expect(frame).not.toHaveBeenCalled();
	});
});
