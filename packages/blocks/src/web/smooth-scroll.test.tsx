import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type Lenis from "lenis";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Lenis's own `autoRaf` loop ran every frame for the life of the page and it
// observed the document from the moment it loaded. The website now creates it
// on the first input it smooths, and advances it only while a smooth scroll is
// animating, so an idle page does no per-frame scroll work.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let reduceMotion = false;
window.matchMedia = ((query: string) => ({
	addEventListener: () => undefined,
	addListener: () => undefined,
	matches: query.includes("reduced-motion") ? reduceMotion : false,
	media: query,
	removeEventListener: () => undefined,
	removeListener: () => undefined,
})) as unknown as typeof window.matchMedia;

// Frames run only when a test flushes them, so a loop that keeps rescheduling
// itself shows up as a queue that never drains.
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let frameTime = 1000;
window.requestAnimationFrame = (callback: FrameRequestCallback) => {
	nextFrameId += 1;
	frames.set(nextFrameId, callback);
	return nextFrameId;
};
window.cancelAnimationFrame = (handle: number) => {
	frames.delete(handle);
};

function flushFrame(step = 16): void {
	frameTime += step;
	const pending = [...frames.values()];
	frames.clear();
	for (const callback of pending) {
		callback(frameTime);
	}
}

/** Flushes frames until none are requested; fails if the loop never settles. */
async function drainFrames(limit = 20): Promise<number> {
	let flushed = 0;
	await act(async () => {
		while (frames.size > 0) {
			if (flushed >= limit) {
				throw new Error("frame loop did not settle");
			}
			flushFrame();
			flushed += 1;
			await Promise.resolve();
		}
	});
	return flushed;
}

const nowSpy = spyOn(performance, "now").mockImplementation(() => frameTime);

const { useLenis } = await import("lenis/react");
const { ScrollProgress, SmoothScroll } = await import("./smooth-scroll.tsx");
const { driveLenisOnDemand } = await import("./smooth-scroll-frames.ts");
const { isSmoothScrollPaused, usePauseSmoothScroll } = await import(
	"./smooth-scroll-pause.ts"
);

function PauseProbe({ paused }: { paused: boolean }) {
	usePauseSmoothScroll(paused);
	return null;
}

let seen: Lenis | undefined;
function LenisProbe() {
	seen = useLenis();
	return null;
}

let mounted: { container: HTMLElement; root: Root } | undefined;

beforeEach(() => {
	reduceMotion = false;
	seen = undefined;
	frames.clear();
});

afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => root.unmount());
		container.remove();
		mounted = undefined;
	}
	frames.clear();
});

afterAll(async () => {
	nowSpy.mockRestore();
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function render(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(node));
	mounted = { container, root };
	return container;
}

async function wheel() {
	await act(async () => {
		window.dispatchEvent(new Event("wheel"));
		await Promise.resolve();
	});
}

test("root mode creates Lenis only on the first wheel", async () => {
	await render(
		<>
			<SmoothScroll root />
			<ScrollProgress />
			<LenisProbe />
		</>
	);
	expect(seen).toBeUndefined();
	expect(document.documentElement.classList.contains("lenis")).toBe(false);
	await drainFrames();

	// Keyboard and touch scrolling stay native, so they do not create Lenis.
	await act(async () => {
		window.dispatchEvent(new Event("keydown"));
		window.dispatchEvent(new Event("touchstart"));
		await Promise.resolve();
	});
	expect(seen).toBeUndefined();

	await wheel();
	expect(seen).toBeDefined();
	expect(document.documentElement.classList.contains("lenis")).toBe(true);
	// No autoRaf loop: an idle Lenis requests no frames.
	await drainFrames();
	expect(frames.size).toBe(0);
});

test("an open menu holds Lenis stopped until every pause is released", async () => {
	const tree = (first: boolean, second: boolean) => (
		<>
			<SmoothScroll root />
			<LenisProbe />
			<PauseProbe paused={first} />
			<PauseProbe paused={second} />
		</>
	);
	await render(tree(false, false));
	await wheel();
	expect(seen?.isStopped).toBe(false);

	const root = mounted?.root;
	await act(async () => root?.render(tree(true, true)));
	expect(isSmoothScrollPaused()).toBe(true);
	expect(seen?.isStopped).toBe(true);

	await act(async () => root?.render(tree(false, true)));
	expect(seen?.isStopped).toBe(true);

	await act(async () => root?.render(tree(false, false)));
	expect(isSmoothScrollPaused()).toBe(false);
	expect(seen?.isStopped).toBe(false);
});

test("a pause requested before Lenis loads applies once it is created", async () => {
	await render(
		<>
			<SmoothScroll root />
			<LenisProbe />
			<PauseProbe paused />
		</>
	);
	expect(seen).toBeUndefined();
	await wheel();
	expect(seen?.isStopped).toBe(true);
});

test("the root-mode children are not remounted when Lenis is created", async () => {
	const container = await render(
		<SmoothScroll root>
			<input data-testid="field" />
		</SmoothScroll>
	);
	const field = container.querySelector('[data-testid="field"]');
	await wheel();
	expect(container.querySelector('[data-testid="field"]')).toBe(field);
});

test("reduced motion keeps native scrolling", async () => {
	reduceMotion = true;
	await render(
		<>
			<SmoothScroll root />
			<LenisProbe />
		</>
	);
	await wheel();
	expect(seen).toBeUndefined();
});

test("a contained scroller creates Lenis at mount without a frame loop", async () => {
	await render(
		<SmoothScroll root={false}>
			<LenisProbe />
		</SmoothScroll>
	);
	expect(seen).toBeDefined();
	await drainFrames();
	expect(frames.size).toBe(0);
});

class FakeLenis {
	isScrolling: false | "native" | "smooth" = false;
	readonly times: number[] = [];
	readonly targets: unknown[] = [];
	remainingFrames = 0;
	raf = (time: number) => {
		this.times.push(time);
		this.remainingFrames -= 1;
		if (this.remainingFrames <= 0) {
			this.isScrolling = false;
		}
	};
	scrollTo(target: unknown) {
		this.targets.push(target);
		this.isScrolling = "smooth";
		this.remainingFrames = 3;
	}
}

const asLenis = (fake: FakeLenis) => fake as unknown as Lenis;

test("the frame loop runs only while a smooth scroll animates", async () => {
	const fake = new FakeLenis();
	const stop = driveLenisOnDemand(asLenis(fake));
	expect(frames.size).toBe(0);

	asLenis(fake).scrollTo(120);
	expect(fake.targets).toEqual([120]);
	expect(await drainFrames()).toBe(3);
	expect(fake.times).toHaveLength(3);

	// An idle gap does not count as animation time: the next scroll eases from
	// its first frame instead of jumping by the time the page sat still.
	frameTime += 60_000;
	const before = fake.times.at(-1) ?? 0;
	asLenis(fake).scrollTo(240);
	await drainFrames();
	const [first = 0, second = 0] = fake.times.slice(3);
	expect(first - before).toBe(16);
	expect(second - first).toBe(16);
	stop();
});

test("a scroll that started before the driver attached still finishes", async () => {
	const fake = new FakeLenis();
	fake.scrollTo(80);
	expect(frames.size).toBe(0);
	const stop = driveLenisOnDemand(asLenis(fake));
	expect(await drainFrames()).toBe(3);
	expect(fake.isScrolling).toBe(false);
	stop();
});

test("cleanup cancels a pending frame and restores scrollTo", async () => {
	const fake = new FakeLenis();
	const stop = driveLenisOnDemand(asLenis(fake));
	expect(Object.hasOwn(fake, "scrollTo")).toBe(true);
	asLenis(fake).scrollTo(10);
	expect(frames.size).toBe(1);
	stop();
	expect(frames.size).toBe(0);
	expect(Object.hasOwn(fake, "scrollTo")).toBe(false);
	expect(fake.scrollTo).toBe(FakeLenis.prototype.scrollTo);
});
