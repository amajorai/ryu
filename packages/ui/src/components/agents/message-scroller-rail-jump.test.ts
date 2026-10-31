// Guards how a rail jump lands on its message. Transcript rows render behind
// `content-visibility: auto` placeholders, so rows above a jump's target grow
// as the jump reveals them and keep resizing briefly afterwards. Without the
// anchoring checked here, the jump ends on a neighbouring message and the
// rail's active item follows it (the flaky e2e `chat-preview-rail-story`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	railJumpCorrection,
	startRailJump,
} from "./message-scroller-rail-jump.ts";

const VIEWPORT_HEIGHT = 400;
const TARGET_HEIGHT = 100;

type Listener = () => void;

function createScene({
	targetTop,
	scrollHeight,
}: {
	targetTop: number;
	scrollHeight: number;
}) {
	const listeners = new Map<string, Set<Listener>>();
	const scrollBys: number[] = [];
	const scene = {
		/** The target's offset from the top of the content. */
		targetTop,
		viewport: {
			scrollTop: 0,
			scrollHeight,
			clientHeight: VIEWPORT_HEIGHT,
			onscrollend: null,
			getBoundingClientRect: () => ({ top: 0, height: VIEWPORT_HEIGHT }),
			addEventListener: (type: string, listener: Listener) => {
				const set = listeners.get(type) ?? new Set<Listener>();
				set.add(listener);
				listeners.set(type, set);
			},
			removeEventListener: (type: string, listener: Listener) => {
				listeners.get(type)?.delete(listener);
			},
			scrollBy: ({ top }: { top: number }) => {
				scrollBys.push(top);
			},
		},
		target: {
			isConnected: true,
			getBoundingClientRect: () => ({
				top: scene.targetTop - scene.viewport.scrollTop,
				height: TARGET_HEIGHT,
			}),
		},
		scrollBys,
		dispatch: (type: string) => {
			for (const listener of [...(listeners.get(type) ?? [])]) {
				listener();
			}
		},
		listenerCount: () =>
			[...listeners.values()].reduce((total, set) => total + set.size, 0),
		/** The scroll position that centres the target. */
		centredScrollTop: () =>
			scene.targetTop + TARGET_HEIGHT / 2 - VIEWPORT_HEIGHT / 2,
	};
	return scene;
}

type Scene = ReturnType<typeof createScene>;

function asElements(scene: Scene) {
	return {
		viewport: scene.viewport as unknown as HTMLElement,
		target: scene.target as unknown as HTMLElement,
	};
}

let frames: FrameRequestCallback[] = [];
let clock = 0;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

/** Run one animation frame, `ms` after the previous one. */
function runFrame(ms = 16) {
	clock += ms;
	const pending = frames;
	frames = [];
	for (const callback of pending) {
		callback(clock);
	}
}

beforeEach(() => {
	frames = [];
	clock = 0;
	globalThis.requestAnimationFrame = (callback) => {
		frames.push(callback);
		return frames.length;
	};
	globalThis.cancelAnimationFrame = () => {
		frames = [];
	};
});

afterEach(() => {
	globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

describe("railJumpCorrection", () => {
	test("measures the scroll that centres the target", () => {
		const scene = createScene({ targetTop: 1000, scrollHeight: 4000 });
		scene.viewport.scrollTop = 500;
		const { viewport, target } = asElements(scene);
		expect(railJumpCorrection(viewport, target)).toBe(
			scene.centredScrollTop() - 500
		);
	});

	test("never asks for a scroll past either end", () => {
		const nearTop = createScene({ targetTop: 20, scrollHeight: 4000 });
		nearTop.viewport.scrollTop = 300;
		const top = asElements(nearTop);
		expect(railJumpCorrection(top.viewport, top.target)).toBe(-300);

		const nearEnd = createScene({ targetTop: 3950, scrollHeight: 4000 });
		const end = asElements(nearEnd);
		expect(railJumpCorrection(end.viewport, end.target)).toBe(
			4000 - VIEWPORT_HEIGHT
		);
	});
});

describe("startRailJump", () => {
	test("keeps the target centred while rows above it resize, then settles once", () => {
		const scene = createScene({ targetTop: 2000, scrollHeight: 6000 });
		scene.viewport.scrollTop = scene.centredScrollTop();
		let settled = 0;
		const jump = startRailJump({
			id: "rail-user-12",
			...asElements(scene),
			smooth: false,
			onSettled: () => {
				settled += 1;
			},
		});
		expect(jump.id).toBe("rail-user-12");

		// A row above the target leaves its 160px placeholder for its real height.
		scene.targetTop += 80;
		scene.viewport.scrollHeight += 80;
		runFrame();
		expect(scene.viewport.scrollTop).toBe(scene.centredScrollTop());

		// ...and shrinks again a few hundred milliseconds later.
		runFrame(300);
		scene.targetTop -= 31;
		scene.viewport.scrollHeight -= 31;
		runFrame(300);
		expect(scene.viewport.scrollTop).toBe(scene.centredScrollTop());
		expect(settled).toBe(0);

		// Settles only after the layout has held still.
		for (let index = 0; index < 60 && frames.length > 0; index += 1) {
			runFrame();
		}
		expect(settled).toBe(1);
		expect(frames).toHaveLength(0);
		expect(scene.viewport.scrollTop).toBe(scene.centredScrollTop());
	});

	test("waits for a smooth scroll to end, then glides the rest of the way", () => {
		const scene = createScene({ targetTop: 2000, scrollHeight: 6000 });
		let settled = 0;
		startRailJump({
			id: "rail-user-12",
			...asElements(scene),
			smooth: true,
			onSettled: () => {
				settled += 1;
			},
		});

		// Nothing re-centres while the browser's own smooth scroll is running.
		scene.dispatch("scroll");
		runFrame();
		expect(frames).toHaveLength(0);

		// It ended short: rows above the target grew while it ran.
		scene.viewport.scrollTop = scene.centredScrollTop();
		scene.targetTop += 300;
		scene.dispatch("scrollend");
		expect(scene.scrollBys).toEqual([300]);

		scene.viewport.scrollTop = scene.centredScrollTop();
		scene.dispatch("scrollend");
		expect(scene.scrollBys).toEqual([300]);
		for (let index = 0; index < 80 && frames.length > 0; index += 1) {
			runFrame();
		}
		expect(settled).toBe(1);
		expect(scene.listenerCount()).toBe(0);
	});

	test("cancel leaves the scroll to the reader", () => {
		const scene = createScene({ targetTop: 2000, scrollHeight: 6000 });
		let settled = 0;
		const jump = startRailJump({
			id: "rail-user-12",
			...asElements(scene),
			smooth: false,
			onSettled: () => {
				settled += 1;
			},
		});
		jump.cancel();
		scene.targetTop += 500;
		runFrame();
		expect(scene.viewport.scrollTop).toBe(0);
		expect(settled).toBe(0);
		expect(scene.listenerCount()).toBe(0);
	});
});
