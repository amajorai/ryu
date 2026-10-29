import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The pricing cards' rotating rings and plan badges loop forever. A ring that
// only shows on hover must stay paused while hidden, and every loop in a card
// must pause while the card is off screen, without the card re-rendering.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const observers: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver {
	readonly callback: IntersectionObserverCallback;
	readonly targets = new Set<Element>();
	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
		observers.push(this);
	}
	disconnect() {
		this.targets.clear();
		observers.splice(observers.indexOf(this), 1);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	report(target: Element, isIntersecting: boolean) {
		this.callback(
			[{ isIntersecting, target } as IntersectionObserverEntry],
			this as unknown as IntersectionObserver
		);
	}
}

const previousObserver = Reflect.get(globalThis, "IntersectionObserver");
Reflect.set(globalThis, "IntersectionObserver", FakeIntersectionObserver);

const { PricingCardBorder } = await import("./pricing-card-parts.tsx");
const { MOTION_OFFSCREEN_ATTRIBUTE } = await import("./pricing-motion.ts");
const { default: motionStyles } = await import("./pricing-motion.module.css");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root?.render(element));
	return container;
}

function unmount() {
	act(() => root?.unmount());
	container?.remove();
	root = null;
	container = null;
}

afterEach(unmount);

afterAll(() => {
	Reflect.set(globalThis, "IntersectionObserver", previousObserver);
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
});

test("the motion module exposes scoped classes", () => {
	expect(motionStyles.idleRing).toBeTruthy();
	expect(motionStyles.offscreenAware).toBeTruthy();
});

test("a hover-only ring carries the idle pause; a highlighted ring does not", () => {
	const hidden = render(
		<PricingCardBorder variant="teams">
			<p>Teams</p>
		</PricingCardBorder>
	);
	const hiddenRing = hidden.querySelector(".t-card-border-spin");
	expect(hiddenRing?.classList.contains(motionStyles.idleRing)).toBe(true);
	unmount();

	const highlighted = render(
		<PricingCardBorder isRecommended variant="teams">
			<p>Teams</p>
		</PricingCardBorder>
	);
	const visibleRing = highlighted.querySelector(".t-card-border-spin");
	expect(visibleRing?.classList.contains(motionStyles.idleRing)).toBe(false);
});

test("a card is marked while off screen and unmarked when it returns", () => {
	const view = render(
		<PricingCardBorder variant="pro">
			<p>Pro</p>
		</PricingCardBorder>
	);
	const frame = view.querySelector(".t-pro-card-border");
	expect(frame?.classList.contains(motionStyles.offscreenAware)).toBe(true);
	const [observer] = observers;
	expect(observer?.targets.has(frame as Element)).toBe(true);
	expect(frame?.hasAttribute(MOTION_OFFSCREEN_ATTRIBUTE)).toBe(false);

	act(() => observer?.report(frame as Element, false));
	expect(frame?.hasAttribute(MOTION_OFFSCREEN_ATTRIBUTE)).toBe(true);

	act(() => observer?.report(frame as Element, true));
	expect(frame?.hasAttribute(MOTION_OFFSCREEN_ATTRIBUTE)).toBe(false);
});

test("cards share one observer, released with the last card", () => {
	render(
		<>
			<PricingCardBorder variant="teams">
				<p>Teams</p>
			</PricingCardBorder>
			<PricingCardBorder variant="business">
				<p>Business</p>
			</PricingCardBorder>
		</>
	);
	expect(observers).toHaveLength(1);
	expect(observers[0]?.targets.size).toBe(2);
	unmount();
	expect(observers).toHaveLength(0);
});
