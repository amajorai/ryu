import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The hero and header download beams inject an ~8 KB stylesheet and animate
// registered custom properties every frame, so they mount only after the
// browser is idle and the visitor has engaged with the page, only near the
// viewport, and never under reduced motion.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const idleTasks: (() => void)[] = [];
const observers: { callback: IntersectionObserverCallback }[] = [];
let reduceMotion = false;

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
		// Entries are delivered by `setNearViewport`.
	}
	unobserve() {
		// Not used by the beam gate.
	}
}

Reflect.set(globalThis, "IntersectionObserver", FakeIntersectionObserver);
window.requestIdleCallback = ((task: () => void) => {
	idleTasks.push(task);
	return idleTasks.length;
}) as typeof window.requestIdleCallback;
window.cancelIdleCallback = () => undefined;
window.matchMedia = ((query: string) => ({
	addEventListener: () => undefined,
	matches: query.includes("reduced-motion") ? reduceMotion : false,
	media: query,
	removeEventListener: () => undefined,
})) as unknown as typeof window.matchMedia;

const { LandingDownloadBeam } = await import("./landing-download-beam.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;

beforeEach(() => {
	idleTasks.length = 0;
	reduceMotion = false;
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

async function renderBeam() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<LandingDownloadBeam borderRadius={28} testId="beam">
				<button type="button">Download</button>
			</LandingDownloadBeam>
		)
	);
	mounted = { container, root };
	return container;
}

// The beam's library is a lazy chunk, so let its import settle too.
const nextFrame = () =>
	new Promise((resolve) => window.requestAnimationFrame(resolve));

async function runIdle() {
	await act(async () => {
		for (const task of idleTasks.splice(0)) {
			task();
		}
		await import("@ryu/ui/components/border-beam.tsx");
		await nextFrame();
	});
}

async function setNearViewport(isIntersecting: boolean) {
	await act(async () => {
		for (const observer of [...observers]) {
			observer.callback(
				[{ isIntersecting } as IntersectionObserverEntry],
				observer as unknown as IntersectionObserver
			);
		}
	});
}

async function engage(type = "pointermove") {
	await act(async () => {
		window.dispatchEvent(new Event(type));
		await import("@ryu/ui/components/border-beam.tsx");
		await nextFrame();
	});
}

const beam = (container: HTMLElement) =>
	container.querySelector('[data-testid="beam"]');

test("the beam waits for idle, engagement and the viewport before mounting", async () => {
	const container = await renderBeam();
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);

	await setNearViewport(true);
	expect(container.querySelector("style")).toBeNull();

	await runIdle();
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);
	expect(container.querySelector("style")).toBeNull();

	await engage();
	expect(beam(container)?.hasAttribute("data-beam")).toBe(true);
	expect(beam(container)?.hasAttribute("data-active")).toBe(true);
	expect(container.querySelector("style")).not.toBeNull();
});

test("engagement before idle mounts the beam once the browser is idle", async () => {
	const container = await renderBeam();
	await setNearViewport(true);
	await engage("scroll");
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);

	await runIdle();
	expect(beam(container)?.hasAttribute("data-beam")).toBe(true);
});

test("every engagement input counts", async () => {
	for (const type of [
		"keydown",
		"pointerdown",
		"pointermove",
		"scroll",
		"touchstart",
		"wheel",
	]) {
		const container = await renderBeam();
		await setNearViewport(true);
		await runIdle();
		await engage(type);
		expect(beam(container)?.hasAttribute("data-beam")).toBe(true);
		const { root } = mounted ?? {};
		await act(async () => root?.unmount());
		container.remove();
		mounted = undefined;
	}
});

test("an off-screen beam stays a plain frame after idle", async () => {
	const container = await renderBeam();
	await runIdle();
	await engage();
	await setNearViewport(false);
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);
	expect(container.querySelector("style")).toBeNull();
});

test("reduced motion never mounts the beam", async () => {
	reduceMotion = true;
	const container = await renderBeam();
	await setNearViewport(true);
	await runIdle();
	await engage();
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);
	expect(container.querySelector("style")).toBeNull();
});

test("the swap waits while the button is focused or its menu is open", async () => {
	const container = await renderBeam();
	const button = container.querySelector("button");
	button?.focus();
	await setNearViewport(true);
	await runIdle();
	await engage("keydown");
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);

	button?.setAttribute("aria-expanded", "true");
	await act(async () => {
		button?.blur();
		await nextFrame();
	});
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);

	button?.setAttribute("aria-expanded", "false");
	button?.focus();
	await act(async () => {
		button?.blur();
		await nextFrame();
	});
	expect(beam(container)?.hasAttribute("data-beam")).toBe(true);
});

const pointerEvent = (type: string, pointerType = "mouse") => {
	const event = new Event(type, { bubbles: true });
	Reflect.set(event, "pointerType", pointerType);
	return event;
};

test("the swap waits while a mouse rests over the frame", async () => {
	const container = await renderBeam();
	const button = container.querySelector("button");
	await act(async () => {
		button?.dispatchEvent(pointerEvent("pointerover"));
	});
	await setNearViewport(true);
	await runIdle();
	await engage();
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);

	await act(async () => {
		beam(container)?.dispatchEvent(pointerEvent("pointerleave"));
		await nextFrame();
	});
	expect(beam(container)?.hasAttribute("data-beam")).toBe(true);
});

test("a press in the frame holds the swap until it is released", async () => {
	const container = await renderBeam();
	const button = container.querySelector("button");
	await setNearViewport(true);
	await runIdle();
	await act(async () => {
		button?.dispatchEvent(pointerEvent("pointerdown", "touch"));
	});
	await engage("touchstart");
	expect(beam(container)?.hasAttribute("data-beam-placeholder")).toBe(true);

	await act(async () => {
		window.dispatchEvent(pointerEvent("pointerup", "touch"));
		await nextFrame();
	});
	expect(beam(container)?.hasAttribute("data-beam")).toBe(true);
});
