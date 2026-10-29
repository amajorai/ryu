import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// happy-dom has no layout engine. This model reproduces the browser contract
// the composer's auto-resize depends on: an element outside the document or
// under a `display: none` ancestor has an empty box and a zero `scrollHeight`;
// a rendered textarea's content height is its wrapped line count times the
// line height at its rendered width.
const LINE_HEIGHT = 23;
const CHAR_WIDTH = 8;
const layout = { paneWidth: 640 };

function isRendered(element: Element): boolean {
	if (!element.isConnected) {
		return false;
	}
	for (
		let node: Element | null = element;
		node !== null;
		node = node.parentElement
	) {
		if (getComputedStyle(node).display === "none") {
			return false;
		}
	}
	return true;
}

function boxWidth(element: Element): number {
	if (!isRendered(element)) {
		return 0;
	}
	const explicit =
		element instanceof HTMLElement
			? Number.parseFloat(element.style.width)
			: Number.NaN;
	return Number.isFinite(explicit) && explicit > 0
		? explicit
		: layout.paneWidth;
}

function textareaContentHeight(textarea: HTMLTextAreaElement): number {
	const width = boxWidth(textarea);
	if (width === 0) {
		return 0;
	}
	const charsPerLine = Math.max(1, Math.floor(width / CHAR_WIDTH));
	let lines = 0;
	for (const line of textarea.value.split("\n")) {
		lines += Math.max(1, Math.ceil(line.length / charsPerLine));
	}
	return lines * LINE_HEIGHT;
}

function boxHeight(element: Element): number {
	if (!isRendered(element)) {
		return 0;
	}
	if (element instanceof HTMLTextAreaElement) {
		return Number.parseFloat(element.style.height) || 0;
	}
	let height = 0;
	for (const textarea of element.querySelectorAll("textarea")) {
		height += boxHeight(textarea);
	}
	return height;
}

const originalScrollHeight = Object.getOwnPropertyDescriptor(
	HTMLTextAreaElement.prototype,
	"scrollHeight"
);
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const originalResizeObserver = globalThis.ResizeObserver;

Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
	configurable: true,
	get(this: HTMLTextAreaElement) {
		return textareaContentHeight(this);
	},
});
Element.prototype.getBoundingClientRect = function getBoundingClientRect(
	this: Element
) {
	return new DOMRect(0, 0, boxWidth(this), boxHeight(this));
};

interface Observation {
	height: number;
	width: number;
}

const liveObservers = new Set<LayoutResizeObserver>();
const loopErrors: string[] = [];

// Delivers observations the way a browser does after layout: an observation
// starts at 0x0, and only targets whose box changed are reported.
class LayoutResizeObserver {
	readonly targets = new Map<Element, Observation>();
	readonly #callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.#callback = callback;
	}

	observe(target: Element) {
		this.targets.set(target, { height: 0, width: 0 });
		liveObservers.add(this);
	}

	unobserve(target: Element) {
		this.targets.delete(target);
	}

	disconnect() {
		this.targets.clear();
		liveObservers.delete(this);
	}

	deliver() {
		const entries: ResizeObserverEntry[] = [];
		for (const [target, last] of this.targets) {
			const width = boxWidth(target);
			const height = boxHeight(target);
			if (width !== last.width || height !== last.height) {
				this.targets.set(target, { height, width });
				entries.push({
					borderBoxSize: [],
					contentBoxSize: [],
					contentRect: new DOMRect(0, 0, width, height),
					devicePixelContentBoxSize: [],
					target,
				});
			}
		}
		if (entries.length > 0) {
			// SAFETY: the callback only receives this observer back as its owner;
			// the model implements observe/unobserve/disconnect of that contract.
			this.#callback(entries, this as unknown as ResizeObserver);
		}
	}
}

// One rendering frame: resize observations are delivered, then any animation
// frame a callback requested runs. Resizing an observed target synchronously
// inside a callback is what the browser reports as a loop error.
async function frame() {
	await act(async () => {
		const observers = [...liveObservers];
		for (const observer of observers) {
			observer.deliver();
		}
		for (const observer of observers) {
			for (const [target, last] of observer.targets) {
				if (
					boxWidth(target) !== last.width ||
					boxHeight(target) !== last.height
				) {
					loopErrors.push(
						"ResizeObserver loop completed with undelivered notifications."
					);
				}
			}
		}
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => resolve());
		});
	});
}

globalThis.ResizeObserver =
	LayoutResizeObserver as unknown as typeof ResizeObserver;

afterAll(async () => {
	globalThis.ResizeObserver = originalResizeObserver;
	Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
	if (originalScrollHeight) {
		Object.defineProperty(
			HTMLTextAreaElement.prototype,
			"scrollHeight",
			originalScrollHeight
		);
	} else {
		Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
	}
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { InputBar } = await import("./input-bar.tsx");

// React clears its root container on first commit, so slots live in a
// separate stage element beside it.
let host: HTMLDivElement;
let stage: HTMLDivElement;
let root: Root;
let setDraft: (value: string) => void = () => undefined;

function Composer({
	compact,
	initial = "",
}: {
	compact?: boolean;
	initial?: string;
}) {
	const [value, setValue] = useState(initial);
	setDraft = setValue;
	return (
		<InputBar
			compact={compact}
			onChange={setValue}
			onSend={() => undefined}
			onStop={() => undefined}
			placeholder="Ask a follow up"
			status="ready"
			value={value}
		/>
	);
}

// The retained-tab host contract (WorkbenchItemHost): React renders through a
// portal container created outside the document, and the host's own layout
// effect, which runs after its children's, attaches it to the visible slot.
function DetachedPortalHost({
	children,
	slot,
}: {
	children: ReactNode;
	slot: HTMLElement;
}) {
	const [container] = useState(() => document.createElement("div"));
	useLayoutEffect(() => {
		slot.append(container);
		return () => container.remove();
	}, [container, slot]);
	return createPortal(children, container);
}

function composerTextarea(): HTMLTextAreaElement {
	const textarea = document.querySelector<HTMLTextAreaElement>(
		'textarea[placeholder="Ask a follow up"]'
	);
	if (!textarea) {
		throw new Error("The composer textarea is not mounted");
	}
	return textarea;
}

function composerObservers(): LayoutResizeObserver[] {
	return [...liveObservers].filter((observer) =>
		[...observer.targets.keys()].some(
			(target) => host.contains(target) || stage.contains(target)
		)
	);
}

beforeEach(() => {
	layout.paneWidth = 640;
	loopErrors.length = 0;
	host = document.createElement("div");
	stage = document.createElement("div");
	document.body.append(host, stage);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	stage.remove();
});

test("a composer mounted through a detached portal measures its visible height once its slot is attached", async () => {
	const slot = document.createElement("div");
	stage.append(slot);
	await act(async () =>
		root.render(
			<DetachedPortalHost slot={slot}>
				<Composer compact />
			</DetachedPortalHost>
		)
	);
	const textarea = composerTextarea();
	// The auto-resize ran while the portal container was still detached.
	expect(slot.contains(textarea)).toBe(true);
	expect(textarea.style.height).toBe("0px");

	await frame();

	expect(textarea.style.height).toBe(`${LINE_HEIGHT}px`);
	expect(textarea.getBoundingClientRect().height).toBe(LINE_HEIGHT);
	expect(loopErrors).toEqual([]);
});

test("a retained composer parked under display:none re-measures its restored draft when its tab is revealed", async () => {
	const slot = document.createElement("div");
	stage.append(slot);
	await act(async () =>
		root.render(
			<DetachedPortalHost slot={slot}>
				<Composer compact />
			</DetachedPortalHost>
		)
	);
	await frame();
	const textarea = composerTextarea();
	expect(textarea.style.height).toBe(`${LINE_HEIGHT}px`);

	// Park the tab (another tab is focused), then the host restores a two-line
	// draft into it while it is hidden.
	slot.style.display = "none";
	await frame();
	const draft = "Conserve this queued original-tab draft.\nSecond line.";
	await act(async () => setDraft(draft));
	expect(textarea.style.height).toBe("0px");

	slot.style.display = "";
	await frame();

	expect(composerTextarea()).toBe(textarea);
	expect(textarea.value).toBe(draft);
	expect(textarea.style.height).toBe(`${LINE_HEIGHT * 2}px`);
	await frame();
	expect(textarea.style.height).toBe(`${LINE_HEIGHT * 2}px`);
	expect(loopErrors).toEqual([]);
});

test("narrowing the pane re-wraps a long draft without a resize-observer loop", async () => {
	const draft = "x".repeat(60);
	await act(async () => root.render(<Composer initial={draft} />));
	await frame();
	const textarea = composerTextarea();
	// 640px holds 80 characters per line.
	expect(textarea.style.height).toBe(`${LINE_HEIGHT}px`);

	// 240px holds 30 characters per line, so the same draft needs two lines.
	layout.paneWidth = 240;
	await frame();
	expect(textarea.style.height).toBe(`${LINE_HEIGHT * 2}px`);

	// The height change is observed in the next frame but changes no width, so
	// it neither re-measures into a different height nor loops.
	await frame();
	await frame();
	expect(textarea.style.height).toBe(`${LINE_HEIGHT * 2}px`);
	expect(textarea.value).toBe(draft);
	expect(loopErrors).toEqual([]);
});

test("unmounting a composer disconnects the resize observer that watched its pane", async () => {
	const slot = document.createElement("div");
	stage.append(slot);
	await act(async () =>
		root.render(
			<DetachedPortalHost slot={slot}>
				<Composer compact />
			</DetachedPortalHost>
		)
	);
	await frame();
	const textarea = composerTextarea();
	const watched = composerObservers();
	expect(watched.length).toBeGreaterThan(0);

	await act(async () => root.unmount());
	root = createRoot(host);

	for (const observer of watched) {
		expect(liveObservers.has(observer)).toBe(false);
		expect(observer.targets.size).toBe(0);
	}
	expect(
		[...liveObservers].some((observer) =>
			[...observer.targets.keys()].some(
				(target) => target === textarea || target.contains(textarea)
			)
		)
	).toBe(false);
});
