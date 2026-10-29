import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The seasonal particle layer redraws the whole viewport every frame, so its
// loop starts only after the browser is idle and the visitor has engaged with
// the page, and stops when the layer unmounts.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const idleTasks: (() => void)[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

window.requestIdleCallback = ((task: () => void) => {
	idleTasks.push(task);
	return idleTasks.length;
}) as typeof window.requestIdleCallback;
window.cancelIdleCallback = () => undefined;
window.requestAnimationFrame = (callback: FrameRequestCallback) => {
	const id = nextFrame++;
	frames.set(id, callback);
	return id;
};
window.cancelAnimationFrame = (id: number) => {
	frames.delete(id);
};
window.matchMedia = ((query: string) => ({
	addEventListener: () => undefined,
	addListener: () => undefined,
	matches: false,
	media: query,
	removeEventListener: () => undefined,
	removeListener: () => undefined,
})) as unknown as typeof window.matchMedia;
// happy-dom has no 2D canvas; the loop only needs these calls to exist.
HTMLCanvasElement.prototype.getContext = (() =>
	new Proxy(
		{},
		{ get: () => () => undefined }
	)) as unknown as HTMLCanvasElement["getContext"];

const { SeasonalParticles } = await import("./seasonal-particles.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;

beforeEach(() => {
	idleTasks.length = 0;
	frames.clear();
});

afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => root.unmount());
		container.remove();
		mounted = undefined;
	}
});

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderParticles() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<SeasonalParticles season="halloween" />));
	mounted = { container, root };
}

async function runIdle() {
	await act(async () => {
		for (const task of idleTasks.splice(0)) {
			task();
		}
	});
}

async function engage() {
	await act(async () => {
		window.dispatchEvent(new Event("pointerdown"));
	});
}

test("no frame loop before the browser is idle and the visitor engages", async () => {
	await renderParticles();
	expect(document.querySelector("[data-testid=seasonal-particles]")).not.toBe(
		null
	);
	expect(frames.size).toBe(0);

	await runIdle();
	expect(frames.size).toBe(0);

	await engage();
	expect(frames.size).toBe(1);
});

test("engagement before idle starts the loop once the browser is idle", async () => {
	await renderParticles();
	await engage();
	expect(frames.size).toBe(0);

	await runIdle();
	expect(frames.size).toBe(1);
});

test("unmounting stops a running loop", async () => {
	await renderParticles();
	await runIdle();
	await engage();
	expect(frames.size).toBe(1);

	const { container, root } = mounted ?? {};
	await act(async () => root?.unmount());
	container?.remove();
	mounted = undefined;
	expect(frames.size).toBe(0);
});
