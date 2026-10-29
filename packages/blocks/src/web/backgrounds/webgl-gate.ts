/*
 * One gate for every animated canvas backdrop on the public site. A full-screen
 * shader needs a hardware GPU: under software rendering (SwiftShader, a
 * blocklisted driver) one frame costs the main thread whole seconds, so those
 * visitors keep the static fallback instead. Contexts are requested with
 * `failIfMajorPerformanceCaveat`, which makes the browser refuse some software
 * GL, and `isSoftwareRenderer` catches the rest: current Chromium hands out
 * ANGLE on SwiftShader even with that flag set. Every loop runs through
 * `createFrameLoop`, which draws only while its element is on screen and the
 * tab is visible.
 *
 * Pure DOM helpers, no React: the vendored effects import them too.
 */

export type WebglKind = "webgl" | "webgl2";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Backdrops are soft and low-frequency; past 1.5x the extra pixels are not visible. */
export const BACKDROP_MAX_PIXEL_RATIO = 1.5;

/**
 * Context attributes for a full-screen backdrop quad. Annotated rather than
 * `as const`, so `getContext` resolves its WebGL overload instead of the
 * `RenderingContext` catch-all.
 */
export const BACKDROP_CONTEXT_ATTRIBUTES: Readonly<WebGLContextAttributes> = {
	alpha: true,
	antialias: false,
	depth: false,
	failIfMajorPerformanceCaveat: true,
	powerPreference: "low-power",
	premultipliedAlpha: true,
	preserveDrawingBuffer: false,
	stencil: false,
};

// CPU rasterizers that WebGL can land on: Chromium's SwiftShader (also via
// ANGLE), Mesa's llvmpipe/softpipe, and Windows' Basic Render Driver.
const SOFTWARE_RENDERER =
	/swiftshader|llvmpipe|softpipe|software|basic render driver/i;

type RendererInfoContext = Pick<
	WebGLRenderingContext,
	"getExtension" | "getParameter" | "RENDERER"
>;

/**
 * Whether `gl` rasterizes on the CPU. Reads the unmasked renderer where the
 * browser exposes it (the masked RENDERER is a vendor placeholder in Chromium).
 */
export function isSoftwareRenderer(gl: RendererInfoContext): boolean {
	try {
		const info = gl.getExtension("WEBGL_debug_renderer_info");
		const renderer: unknown = info
			? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
			: gl.getParameter(gl.RENDERER);
		return typeof renderer === "string" && SOFTWARE_RENDERER.test(renderer);
	} catch {
		return false;
	}
}

interface ProbeCanvas {
	getContext: HTMLCanvasElement["getContext"];
}

/** Whether the browser hands out a hardware-accelerated context of `kind`. */
export function probeAcceleratedWebgl(
	kind: WebglKind,
	createCanvas: () => ProbeCanvas = () => document.createElement("canvas")
): boolean {
	try {
		const canvas = createCanvas();
		const attributes: WebGLContextAttributes = {
			failIfMajorPerformanceCaveat: true,
		};
		const gl =
			kind === "webgl2"
				? canvas.getContext("webgl2", attributes)
				: canvas.getContext("webgl", attributes);
		if (!gl) {
			return false;
		}
		const software = isSoftwareRenderer(gl);
		// Free the probe's context slot at once; browsers cap live contexts.
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return !software;
	} catch {
		return false;
	}
}

const probes = new Map<WebglKind, boolean>();

/** Cached per page, because a probe costs a context creation. False on the server. */
export function hasAcceleratedWebgl(kind: WebglKind = "webgl"): boolean {
	if (typeof document === "undefined") {
		return false;
	}
	let known = probes.get(kind);
	if (known === undefined) {
		known = probeAcceleratedWebgl(kind);
		probes.set(kind, known);
	}
	return known;
}

export function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true
	);
}

/** The device pixel ratio, capped for backdrop canvases. */
export function backdropPixelRatio(cap = BACKDROP_MAX_PIXEL_RATIO): number {
	return Math.min(globalThis.devicePixelRatio || 1, cap);
}

export interface FrameLoop {
	stop(): void;
	/** Requests a frame (after a resize or a colour change), unless one is pending or the loop is paused. */
	wake(): void;
}

/** The browser seams `createFrameLoop` uses, injectable so tests need no DOM. */
export interface FrameLoopEnv {
	cancelFrame(id: number): void;
	isHidden(): boolean;
	observe(target: Element, onChange: (onScreen: boolean) => void): () => void;
	onVisibilityChange(listener: () => void): () => void;
	requestFrame(callback: (now: number) => void): number;
}

export function browserFrameLoopEnv(): FrameLoopEnv {
	return {
		cancelFrame: (id) => window.cancelAnimationFrame(id),
		isHidden: () => document.hidden,
		observe: (target, onChange) => {
			if (typeof IntersectionObserver === "undefined") {
				return noop;
			}
			// Entries arrive oldest first; the last one is the current state.
			const observer = new IntersectionObserver((entries) => {
				const latest = entries.at(-1);
				if (latest) {
					onChange(latest.isIntersecting);
				}
			});
			observer.observe(target);
			return () => observer.disconnect();
		},
		onVisibilityChange: (listener) => {
			document.addEventListener("visibilitychange", listener);
			return () => document.removeEventListener("visibilitychange", listener);
		},
		requestFrame: (callback) => window.requestAnimationFrame(callback),
	};
}

/**
 * Runs `frame` each animation frame while `target` is on screen and the tab is
 * visible. With `still` (reduced motion) it draws once per wake and never
 * loops. `frame` returns false to idle until the next wake.
 */
export function createFrameLoop(
	target: Element,
	frame: (now: number) => boolean | undefined,
	{ env, still = false }: { env?: FrameLoopEnv; still?: boolean } = {}
): FrameLoop {
	const seams = env ?? browserFrameLoopEnv();
	let id = 0;
	let onScreen = true;
	let stopped = false;

	const halt = () => {
		if (id) {
			seams.cancelFrame(id);
			id = 0;
		}
	};
	const tick = (now: number) => {
		id = 0;
		if (stopped) {
			return;
		}
		const more = frame(now);
		if (more !== false && !still && onScreen && !seams.isHidden()) {
			id = seams.requestFrame(tick);
		}
	};
	const wake = () => {
		if (id || stopped || seams.isHidden() || !(onScreen || still)) {
			return;
		}
		id = seams.requestFrame(tick);
	};

	const unobserve = seams.observe(target, (visible) => {
		onScreen = visible;
		if (visible) {
			wake();
		} else {
			halt();
		}
	});
	const offVisibility = seams.onVisibilityChange(() => {
		if (seams.isHidden()) {
			halt();
		} else {
			wake();
		}
	});
	wake();

	return {
		stop: () => {
			stopped = true;
			halt();
			unobserve();
			offVisibility();
		},
		wake,
	};
}

function noop(): void {
	// Nothing to undo.
}
