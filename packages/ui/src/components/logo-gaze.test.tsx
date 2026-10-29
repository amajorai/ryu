import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The chrome logos (header outline, launcher eyes) must cost nothing until the
// browser is idle, share one rAF-coalesced pointer listener, and stop while off
// screen or in a hidden tab.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const idleTasks: (() => void)[] = [];
const frames: FrameRequestCallback[] = [];
const observers: { callback: IntersectionObserverCallback }[] = [];
let mousemoveListeners = 0;
let visibility: DocumentVisibilityState = "visible";

class FakeIntersectionObserver {
	readonly callback: IntersectionObserverCallback;
	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
		observers.push(this);
	}
	disconnect() {
		observers.splice(observers.indexOf(this), 1);
	}
	observe() {
		// Entries are delivered by `setOnScreen`.
	}
}

const originalAdd = window.addEventListener.bind(window);
const originalRemove = window.removeEventListener.bind(window);
Reflect.set(globalThis, "IntersectionObserver", FakeIntersectionObserver);
window.requestIdleCallback = ((task: () => void) => {
	idleTasks.push(task);
	return idleTasks.length;
}) as typeof window.requestIdleCallback;
window.cancelIdleCallback = () => undefined;
window.requestAnimationFrame = (callback) => {
	frames.push(callback);
	return frames.length;
};
window.cancelAnimationFrame = () => undefined;
window.addEventListener = ((type: string, ...rest: unknown[]) => {
	if (type === "mousemove") {
		mousemoveListeners += 1;
	}
	return (originalAdd as (...args: unknown[]) => void)(type, ...rest);
}) as typeof window.addEventListener;
window.removeEventListener = ((type: string, ...rest: unknown[]) => {
	if (type === "mousemove") {
		mousemoveListeners -= 1;
	}
	return (originalRemove as (...args: unknown[]) => void)(type, ...rest);
}) as typeof window.removeEventListener;
Object.defineProperty(document, "visibilityState", {
	configurable: true,
	get: () => visibility,
});

const { Logo } = await import("./logo.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;

beforeEach(() => {
	idleTasks.length = 0;
	frames.length = 0;
	visibility = "visible";
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
	window.addEventListener = originalAdd;
	window.removeEventListener = originalRemove;
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function render(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(node));
	mounted = { container, root };
	return container;
}

async function runIdle() {
	await act(async () => {
		for (const task of idleTasks.splice(0)) {
			task();
		}
	});
}

async function setOnScreen(isIntersecting: boolean) {
	await act(async () => {
		for (const observer of [...observers]) {
			observer.callback(
				[{ isIntersecting } as IntersectionObserverEntry],
				observer as unknown as IntersectionObserver
			);
		}
	});
}

async function movePointer(clientX: number, clientY: number) {
	await act(async () => {
		window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY }));
	});
}

async function flushFrames() {
	await act(async () => {
		for (const frame of frames.splice(0)) {
			frame(performance.now());
		}
	});
}

const leftEyeX = (container: HTMLElement) =>
	container.querySelector("ellipse")?.getAttribute("cx");

test("chrome logos attach nothing before the browser is idle", async () => {
	const container = await render(<Logo size="28px" variant="outline" />);
	const resting = leftEyeX(container);
	await setOnScreen(true);
	expect(mousemoveListeners).toBe(0);
	await movePointer(400, 10);
	await flushFrames();
	expect(leftEyeX(container)).toBe(resting);
});

test("logos share one pointer listener and follow it once per frame", async () => {
	const container = await render(
		<>
			<Logo size="28px" variant="outline" />
			<Logo size="34px" variant="eyes" />
		</>
	);
	const resting = leftEyeX(container);
	await setOnScreen(true);
	await runIdle();
	expect(mousemoveListeners).toBe(1);

	await movePointer(400, 10);
	await movePointer(500, 20);
	expect(frames).toHaveLength(1);
	await flushFrames();
	expect(leftEyeX(container)).not.toBe(resting);
});

test("gaze stops off screen and in a hidden tab", async () => {
	await render(<Logo size="28px" variant="outline" />);
	await setOnScreen(true);
	await runIdle();
	expect(mousemoveListeners).toBe(1);

	await setOnScreen(false);
	expect(mousemoveListeners).toBe(0);

	await setOnScreen(true);
	expect(mousemoveListeners).toBe(1);
	visibility = "hidden";
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(mousemoveListeners).toBe(0);
});

test("variants without moving eyes install no gaze at all", async () => {
	await render(
		<>
			<Logo size="56px" variant="shimmer" />
			<Logo showEyes={false} size="56px" variant="default" />
			<Logo size="28px" variant="outline-static" />
		</>
	);
	await setOnScreen(true);
	await runIdle();
	expect(mousemoveListeners).toBe(0);
});
