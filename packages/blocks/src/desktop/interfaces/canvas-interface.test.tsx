import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasInterface } from "./canvas-interface.tsx";
import {
	buildCanvasLayout,
	CANVAS_POSITIONS_KEY,
	CARD_HEIGHT,
	CARD_WIDTH,
	type CanvasRect,
	canvasSummary,
	cardPosition,
	cardRect,
	FRAME_GAP,
	FRAME_LABEL,
	FRAME_MIN_GAP,
	FRAME_PADDING,
	findFreeSpot,
	fitCamera,
	fitCameraClear,
	fitCameraInsets,
	fitFrames,
	focusCamera,
	frameColumns,
	gridSpacing,
	interpolateCamera,
	knownOverrides,
	newThreadIds,
	offscreenCards,
	openingCamera,
	parsePositions,
	rectInView,
	revealRect,
	screenToWorld,
	stepZoom,
	visibleWorldRect,
	worldToScreen,
	zoomAt,
} from "./canvas-model.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-12T12:00:00Z");
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: ago(60),
		...input,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Never messaged",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "project-docs",
			kind: "project",
			memberAgentIds: ["agent-ada"],
			name: "Docs Site",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			projectId: "project-docs",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			id: "thread-loose",
			lastMessage: "Who owns this?",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: ago(600),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-pinned",
			pinned: true,
			title: "Pinned plan",
			updatedAt: ago(900),
		}),
	],
	version: 1,
};

function inflate(rect: CanvasRect, by: number): CanvasRect {
	return {
		height: rect.height + by * 2,
		width: rect.width + by * 2,
		x: rect.x - by,
		y: rect.y - by,
	};
}

function overlaps(a: CanvasRect, b: CanvasRect): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

describe("canvas layout", () => {
	test("status frames follow the status order and drop empty ones", () => {
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		expect(layout.frames.map((frame) => frame.id)).toEqual([
			"status:attention",
			"status:your-turn",
			"status:working",
			"status:waiting",
		]);
		// Pinned first, then newest.
		expect(
			layout.frames.find((frame) => frame.id === "status:your-turn")?.threadIds
		).toEqual(["thread-pinned", "thread-notes"]);
		expect(layout.cards).toHaveLength(SNAPSHOT.threads.length);
	});

	test("agent frames follow the agent list, skip idle agents, and end with No agent", () => {
		const layout = buildCanvasLayout(
			{
				...SNAPSHOT,
				threads: [
					...SNAPSHOT.threads,
					thread({ agentIds: ["agent-gone"], id: "thread-orphan" }),
				],
			},
			"agent"
		);
		expect(layout.frames.map((frame) => frame.label)).toEqual([
			"Ada",
			"Grace",
			"No agent",
		]);
		// Newest first: the orphan is an hour old, the loose end ten.
		expect(layout.frames.at(-1)?.threadIds).toEqual([
			"thread-orphan",
			"thread-loose",
		]);
	});

	test("frames never overlap and every home slot sits inside its frame", () => {
		for (const arrange of ["status", "agent"] as const) {
			const layout = buildCanvasLayout(SNAPSHOT, arrange);
			for (const [index, frame] of layout.frames.entries()) {
				for (const other of layout.frames.slice(index + 1)) {
					expect(overlaps(frame.rect, other.rect)).toBe(false);
				}
			}
			for (const card of layout.cards) {
				const frame = layout.frames.find((item) => item.id === card.frameId);
				expect(frame).toBeDefined();
				if (frame) {
					expect(card.home.x).toBeGreaterThanOrEqual(frame.rect.x);
					expect(card.home.y).toBeGreaterThanOrEqual(frame.rect.y);
					expect(card.home.x + CARD_WIDTH).toBeLessThanOrEqual(
						frame.rect.x + frame.rect.width
					);
					expect(card.home.y + CARD_HEIGHT).toBeLessThanOrEqual(
						frame.rect.y + frame.rect.height
					);
				}
			}
		}
	});

	test("cards carry their group, lead agent and status", () => {
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const notes = layout.cards.find((card) => card.id === "thread-notes");
		expect(notes?.group?.name).toBe("Docs Site");
		expect(notes?.lead?.name).toBe("Ada");
		expect(notes?.status).toBe("your-turn");
		expect(
			layout.cards.find((card) => card.id === "thread-loose")?.lead
		).toBeUndefined();
	});

	test("frames stay squarish", () => {
		expect([0, 1, 2, 3, 4, 5, 9, 10, 40].map(frameColumns)).toEqual([
			1, 1, 2, 2, 2, 3, 3, 4, 4,
		]);
	});

	test("an empty snapshot has no frames and an empty bounds", () => {
		const layout = buildCanvasLayout({ ...SNAPSHOT, threads: [] }, "status");
		expect(layout.frames).toEqual([]);
		expect(layout.bounds).toEqual({ height: 0, width: 0, x: 0, y: 0 });
	});

	test("summary counts live and failed threads", () => {
		expect(canvasSummary(SNAPSHOT)).toEqual({
			attention: 1,
			threads: 6,
			working: 1,
		});
	});
});

describe("canvas camera", () => {
	const viewport = { height: 800, width: 1200 };

	test("world and screen round-trip", () => {
		const camera = { x: 120, y: -40, zoom: 1.5 };
		const point = { x: 33, y: 77 };
		expect(screenToWorld(camera, worldToScreen(camera, point))).toEqual(point);
	});

	test("zooming about a point keeps that point still", () => {
		const camera = { x: 10, y: 20, zoom: 1 };
		const anchor = { x: 400, y: 300 };
		const before = screenToWorld(camera, anchor);
		const zoomed = zoomAt(camera, anchor, 2);
		expect(zoomed.zoom).toBe(2);
		const after = screenToWorld(zoomed, anchor);
		expect(after.x).toBeCloseTo(before.x);
		expect(after.y).toBeCloseTo(before.y);
		expect(zoomAt(camera, anchor, 99).zoom).toBe(3);
		expect(zoomAt(camera, anchor, 0.001).zoom).toBe(0.2);
	});

	test("zoom steps walk the stops and clamp at the ends", () => {
		expect(stepZoom(1, 1)).toBe(1.25);
		expect(stepZoom(1, -1)).toBe(0.75);
		expect(stepZoom(0.9, 1)).toBe(1);
		expect(stepZoom(3, 1)).toBe(3);
		expect(stepZoom(0.2, -1)).toBe(0.2);
	});

	test("fit centres the content and never zooms past 100%", () => {
		const small = fitCamera({ height: 100, width: 200, x: 0, y: 0 }, viewport);
		expect(small.zoom).toBe(1);
		expect(small.x).toBe(500);
		expect(small.y).toBe(350);
		const large = fitCamera(
			{ height: 2000, width: 4000, x: 100, y: 100 },
			viewport,
			{ margin: 0 }
		);
		expect(large.zoom).toBeCloseTo(0.3);
		const visible = visibleWorldRect(large, viewport);
		expect(visible.x).toBeCloseTo(100);
	});

	test("fit with insets keeps the content clear of the chrome", () => {
		const rect = { height: 400, width: 400, x: 0, y: 0 };
		const camera = fitCameraInsets(rect, viewport, {
			bottom: 100,
			left: 0,
			right: 200,
			top: 60,
		});
		const topLeft = worldToScreen(camera, rect);
		expect(topLeft.y).toBeGreaterThanOrEqual(60);
		expect(topLeft.x + rect.width * camera.zoom).toBeLessThanOrEqual(1000);
	});

	test("the opening view holds a readable zoom for big boards", () => {
		const insets = { bottom: 0, left: 0, right: 0, top: 0 };
		const big = { height: 600, width: 6000, x: 0, y: 0 };
		const camera = openingCamera(big, viewport, insets, 0.75);
		expect(camera.zoom).toBe(0.75);
		expect(worldToScreen(camera, big).x).toBe(16);
	});

	test("reveal pans the least needed and leaves visible rects alone", () => {
		const camera = { x: 0, y: 0, zoom: 1 };
		const inside = { height: 100, width: 100, x: 200, y: 200 };
		expect(revealRect(camera, inside, viewport)).toBe(camera);
		const right = revealRect(
			camera,
			{ height: 100, width: 100, x: 1300, y: 200 },
			viewport,
			20
		);
		expect(right.x).toBe(1200 - 20 - 1400);
		expect(right.y).toBe(0);
	});

	test("rects in view respect the chrome insets", () => {
		const camera = { x: 0, y: 0, zoom: 1 };
		const insets = { bottom: 76, left: 16, right: 16, top: 64 };
		expect(
			rectInView(
				camera,
				{ height: 100, width: 100, x: 40, y: 80 },
				viewport,
				insets
			)
		).toBe(true);
		expect(
			rectInView(
				camera,
				{ height: 100, width: 100, x: 40, y: 20 },
				viewport,
				insets
			)
		).toBe(false);
		expect(
			rectInView(
				camera,
				{ height: 100, width: 100, x: 1150, y: 80 },
				viewport,
				insets
			)
		).toBe(false);
	});

	test("a docked panel refits the board down to 40%, else centres the focus", () => {
		const insets = { bottom: 0, left: 0, right: 0, top: 0 };
		const narrow = { height: 800, width: 700 };
		const board = { height: 600, width: 1100, x: 0, y: 0 };
		const fitted = focusCamera(board, undefined, narrow, insets);
		expect(fitted.zoom).toBeGreaterThanOrEqual(0.4);
		expect(fitted.zoom).toBeLessThan(0.75);
		expect(rectInView(fitted, board, narrow, insets)).toBe(true);

		const wide = { height: 600, width: 4000, x: 0, y: 0 };
		const frame = { height: 300, width: 600, x: 2400, y: 100 };
		const focused = focusCamera(wide, frame, narrow, insets);
		expect(focused.zoom).toBe(0.4);
		expect(rectInView(focused, frame, narrow, insets)).toBe(true);
	});

	test("off-screen stickies are counted by the side they lie past", () => {
		const visible = { height: 500, width: 500, x: 0, y: 0 };
		const sticky = (x: number, y: number) => ({
			height: CARD_HEIGHT,
			width: CARD_WIDTH,
			x,
			y,
		});
		const result = offscreenCards(
			[
				sticky(100, 100),
				sticky(300, 100),
				sticky(700, 100),
				sticky(1400, 100),
				sticky(100, 900),
				sticky(-600, 0),
			],
			visible
		);
		expect(result.right.count).toBe(2);
		expect(result.right.nearest?.x).toBe(700);
		expect(result.bottom.count).toBe(1);
		expect(result.left.count).toBe(1);
		expect(result.top.count).toBe(0);
		expect(result.top.nearest).toBeUndefined();
	});

	test("camera animation interpolates and lands exactly", () => {
		const from = { x: 0, y: 0, zoom: 0.5 };
		const to = { x: -300, y: 120, zoom: 2 };
		expect(interpolateCamera(from, to, viewport, 1)).toEqual(to);
		expect(interpolateCamera(from, to, viewport, 0).zoom).toBeCloseTo(0.5);
		expect(interpolateCamera(from, to, viewport, 0.5).zoom).toBeCloseTo(1);
	});

	test("the dot grid never gets denser than 16px", () => {
		expect(gridSpacing(1)).toBe(24);
		expect(gridSpacing(0.5)).toBe(24);
		expect(gridSpacing(0.25)).toBe(24);
		expect(gridSpacing(2)).toBe(48);
	});
});

describe("canvas frames", () => {
	test("a sticky moved within its frame grows the frame to hold it", () => {
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const notes = layout.cards.find((item) => item.id === "thread-notes");
		const frame = layout.frames.find((item) => item.id === notes?.frameId);
		if (!(notes && frame)) {
			throw new Error("fixture lacks thread-notes");
		}
		const moved = { x: notes.home.x + 8, y: notes.home.y + 16 };
		const fit = fitFrames(layout, { "thread-notes": moved });
		const grown = fit.rects.get(frame.id);
		expect(fit.loose.has("thread-notes")).toBe(false);
		expect(grown?.height).toBeGreaterThan(frame.rect.height);
		expect((grown?.y ?? 0) + (grown?.height ?? 0)).toBeGreaterThanOrEqual(
			moved.y + CARD_HEIGHT
		);
	});

	test("a frame never grows into the gutter: the sticky lifts out instead", () => {
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const flaky = layout.cards.find((item) => item.id === "thread-flaky");
		if (!flaky) {
			throw new Error("fixture lacks thread-flaky");
		}
		for (let step = 1; step <= 12; step += 1) {
			const moved = { x: flaky.home.x + step * 8, y: flaky.home.y };
			const fit = fitFrames(layout, { "thread-flaky": moved });
			const own = fit.rects.get(flaky.frameId);
			for (const [id, rect] of fit.rects) {
				if (id !== flaky.frameId && own) {
					expect(overlaps(inflate(own, FRAME_MIN_GAP - 1), rect)).toBe(false);
				}
			}
		}
		const far = fitFrames(layout, {
			"thread-flaky": { x: flaky.home.x + 96, y: flaky.home.y },
		});
		expect(far.loose.has("thread-flaky")).toBe(true);
	});

	test("a sticky moved out of its frame gives up its slot: no holes", () => {
		const base = buildCanvasLayout(SNAPSHOT, "status");
		const yourTurn = base.frames.find((item) => item.id === "status:your-turn");
		const pinned = base.cards.find((item) => item.id === "thread-pinned");
		if (!(yourTurn && pinned)) {
			throw new Error("fixture lacks the your-turn frame");
		}
		const overrides = { "thread-pinned": { x: 4000, y: 4000 } };
		const layout = buildCanvasLayout(SNAPSHOT, "status", overrides);
		const frame = layout.frames.find((item) => item.id === "status:your-turn");
		const notes = layout.cards.find((item) => item.id === "thread-notes");
		expect(layout.loose.has("thread-pinned")).toBe(true);
		// The sticky left behind takes the first slot and the frame shrinks.
		expect(notes?.home).toEqual(pinned.home);
		expect(frame?.rect.width).toBeLessThan(yourTurn.rect.width);
		// Frames around it stay where they were.
		for (const other of base.frames) {
			const after = layout.frames.find((item) => item.id === other.id);
			expect(after?.rect.x).toBe(other.rect.x);
			expect(after?.rect.y).toBe(other.rect.y);
		}
	});

	test("a sticky nudged inside its frame keeps its slot", () => {
		const base = buildCanvasLayout(SNAPSHOT, "status");
		const notes = base.cards.find((item) => item.id === "thread-notes");
		const pinned = base.cards.find((item) => item.id === "thread-pinned");
		if (!(notes && pinned)) {
			throw new Error("fixture lacks the your-turn stickies");
		}
		// Nudge the first sticky a little: the second must not slide under it.
		const layout = buildCanvasLayout(SNAPSHOT, "status", {
			"thread-pinned": { x: pinned.home.x + 8, y: pinned.home.y + 8 },
		});
		expect(layout.loose.size).toBe(0);
		expect(
			layout.cards.find((item) => item.id === "thread-notes")?.home
		).toEqual(notes.home);
	});

	test("agent frames share one grid of columns, each only as tall as its stickies", () => {
		const layout = buildCanvasLayout(
			{
				...SNAPSHOT,
				threads: [
					...SNAPSHOT.threads,
					thread({ agentIds: ["agent-linus"], id: "thread-linus" }),
				],
			},
			"agent"
		);
		const widths = new Set(layout.frames.map((frame) => frame.rect.width));
		expect(widths.size).toBe(1);
		for (const frame of layout.frames) {
			const bottom = Math.max(
				...layout.cards
					.filter((item) => item.frameId === frame.id)
					.map((item) => item.home.y + CARD_HEIGHT)
			);
			// The same gutter below the last sticky as at the sides.
			expect(frame.rect.y + frame.rect.height - bottom).toBe(FRAME_PADDING);
		}
		const [width] = widths;
		for (const frame of layout.frames) {
			expect(frame.rect.x % ((width ?? 0) + FRAME_GAP)).toBe(0);
		}
	});

	test("frame bodies sit one gap apart across and down the board", () => {
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const bodies = layout.frames.map((frame) => ({
			bottom: frame.rect.y + frame.rect.height,
			right: frame.rect.x + frame.rect.width,
			top: frame.rect.y + FRAME_LABEL,
			x: frame.rect.x,
		}));
		const rows = [...new Set(bodies.map((body) => body.top))].sort(
			(a, b) => a - b
		);
		expect(rows.length).toBeGreaterThan(1);
		for (const [index, top] of rows.entries()) {
			const row = bodies
				.filter((body) => body.top === top)
				.sort((a, b) => a.x - b.x);
			for (const [column, body] of row.entries()) {
				const next = row[column + 1];
				if (next) {
					expect(next.x - body.right).toBe(FRAME_GAP);
				}
			}
			const below = rows[index + 1];
			if (below !== undefined) {
				const deepest = Math.max(...row.map((body) => body.bottom));
				expect(below - deepest).toBe(FRAME_GAP);
			}
		}
	});

	test("a sticky dragged out of its frame floats free and leaves the frame alone", () => {
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const notes = layout.cards.find((item) => item.id === "thread-notes");
		if (!notes) {
			throw new Error("fixture lacks thread-notes");
		}
		const fit = fitFrames(layout, { "thread-notes": { x: 9000, y: 9000 } });
		expect(fit.loose.has("thread-notes")).toBe(true);
		for (const frame of layout.frames) {
			expect(fit.rects.get(frame.id)).toEqual(frame.rect);
		}
	});
});

describe("canvas placement", () => {
	test("a free spot steps around obstacles to the nearest clear place", () => {
		const size = { height: 100, width: 100 };
		expect(findFreeSpot({ x: 0, y: 0 }, size, [])).toEqual({ x: 0, y: 0 });
		const wall = { height: 400, width: 400, x: -150, y: -150 };
		const spot = findFreeSpot({ x: 0, y: 0 }, size, [wall], { gap: 24 });
		expect(spot).toBeDefined();
		if (spot) {
			expect(overlaps({ ...size, ...spot }, inflate(wall, 23))).toBe(false);
		}
		const boxed = findFreeSpot({ x: 0, y: 0 }, size, [wall], {
			within: { height: 300, width: 300, x: -150, y: -150 },
		});
		expect(boxed).toBeUndefined();
	});

	test("fit centres the board and dodges the minimap only when it covers a sticky", () => {
		const viewport = { height: 800, width: 1400 };
		const insets = { bottom: 76, left: 16, right: 16, top: 64 };
		const board = { height: 500, width: 800, x: 0, y: 0 };
		const minimap = { height: 112, width: 176, x: 1208, y: 672 };
		const clear = fitCameraClear(board, viewport, insets, {
			blockedRight: 216,
			obstacles: [minimap],
			pieces: [board],
		});
		expect(clear.x).toBe((1400 - 800) / 2);
		// A board wide enough to reach the corner shifts just enough to clear it.
		const wide = { height: 600, width: 1300, x: 0, y: 0 };
		const corner = { height: 160, width: 248, x: 1050, y: 440 };
		const shifted = fitCameraClear(wide, viewport, insets, {
			blockedRight: 216,
			obstacles: [minimap],
			pieces: [corner],
		});
		const onScreen = worldToScreen(shifted, corner);
		expect(
			overlaps(
				{
					height: corner.height * shifted.zoom,
					width: corner.width * shifted.zoom,
					...onScreen,
				},
				minimap
			)
		).toBe(false);
	});
});

describe("canvas positions", () => {
	test("parsing is tolerant of anything malformed", () => {
		expect(parsePositions(null)).toEqual({ agent: {}, status: {} });
		expect(parsePositions("not json")).toEqual({ agent: {}, status: {} });
		expect(parsePositions("[1,2]")).toEqual({ agent: {}, status: {} });
		expect(
			parsePositions(
				JSON.stringify({
					agent: { a: { x: "1", y: 2 } },
					status: { b: { x: 10.4, y: -3 }, c: null, d: { x: 1 } },
				})
			)
		).toEqual({ agent: {}, status: { b: { x: 10, y: -3 } } });
	});

	test("overrides for threads the snapshot lacks are ignored", () => {
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const known = knownOverrides(
			{ "thread-gone": { x: 1, y: 1 }, "thread-notes": { x: 5, y: 6 } },
			layout
		);
		expect(known).toEqual({ "thread-notes": { x: 5, y: 6 } });
		const notes = layout.cards.find((card) => card.id === "thread-notes");
		const triage = layout.cards.find((card) => card.id === "thread-triage");
		expect(notes && cardPosition(notes, known)).toEqual({ x: 5, y: 6 });
		expect(triage && cardPosition(triage, known)).toEqual(triage?.home);
	});

	test("new thread ids are the ones the earlier snapshot lacked", () => {
		const before = new Set(["a", "b"]);
		expect(
			newThreadIds(before, [
				thread({ id: "c" }),
				thread({ id: "a" }),
				thread({ id: "d" }),
			])
		).toEqual(["c", "d"]);
	});
});

// ---------------------------------------------------------------------------
// Rendering and interaction
// ---------------------------------------------------------------------------

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

beforeEach(() => {
	try {
		globalThis.localStorage?.clear();
	} catch {
		// Storage may be unavailable; the renderer copes.
	}
});

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

/**
 * Type into a controlled field the way React's onChange observes it. React
 * may have been evaluated before the DOM was registered, in which case it
 * watches the focused field's keyup instead of `input`, so send both.
 */
async function typeInto(field: HTMLTextAreaElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function card(container: HTMLElement, id: string): HTMLElement {
	const element = container.querySelector(`[data-canvas-card="${id}"]`);
	if (!(element instanceof HTMLElement)) {
		throw new Error(`No card ${id}`);
	}
	return element;
}

function viewportOf(container: HTMLElement): HTMLElement {
	const element = container.querySelector('[data-testid="canvas-viewport"]');
	if (!(element instanceof HTMLElement)) {
		throw new Error("No viewport");
	}
	return element;
}

async function press(
	target: Element,
	key: string,
	init: KeyboardEventInit = {}
) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key, ...init })
		);
	});
}

async function pointer(
	target: Element | Window,
	type: string,
	clientX: number,
	clientY: number
) {
	await act(async () => {
		target.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				button: 0,
				clientX,
				clientY,
				pointerId: 1,
			})
		);
	});
}

function canvas(
	overrides: Partial<Parameters<typeof CanvasInterface>[0]> = {}
): ReactElement {
	const { port } = recordingPort();
	return (
		<CanvasInterface
			activeThreadId={null}
			loading={false}
			params={{ arrange: "status", minimap: "auto" }}
			port={port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

describe("CanvasInterface", () => {
	test("renders frames, stickies and the floating chrome", () => {
		const markup = renderToStaticMarkup(canvas());
		expect(markup).toContain('data-testid="interface-canvas"');
		expect(markup.match(/data-testid="canvas-frame"/g)).toHaveLength(4);
		expect(markup.match(/data-testid="canvas-card"/g)).toHaveLength(6);
		expect(markup).toContain('role="toolbar"');
		expect(markup).toContain('aria-label="Canvas tools"');
		expect(markup).toContain('aria-label="Needs attention, 1 thread"');
		expect(markup).toContain("Last run failed");
		expect(markup).toContain("Docs Site");
	});

	test("the header counts attention in the right number", () => {
		const markup = renderToStaticMarkup(canvas());
		expect(markup).toContain("1 needs attention");
	});

	test("stickies are neutral cards: status lives in the frame, not a wash", () => {
		const view = renderToStaticMarkup(canvas());
		const host = document.createElement("div");
		host.innerHTML = view;
		const notes = host.querySelector('[data-canvas-card="thread-notes"]');
		const triage = host.querySelector('[data-canvas-card="thread-triage"]');
		for (const sticky of [notes, triage]) {
			const surface = sticky?.querySelector("span")?.className ?? "";
			expect(surface).toContain("bg-card");
			expect(surface).not.toMatch(
				/before:bg-|bg-(primary|success|warning|destructive)/
			);
		}
		// A live run keeps one cue on the sticky itself: the line on its edge.
		expect(
			triage?.querySelector('[data-testid="canvas-working-track"]')
		).not.toBe(null);
		expect(notes?.querySelector('[data-testid="canvas-working-track"]')).toBe(
			null
		);
	});

	test("zooming out switches stickies to their compact face", async () => {
		const view = await mount(canvas());
		const zoomOut = view.container.querySelector(
			'button[aria-label="Zoom out"]'
		);
		await act(async () => (zoomOut as HTMLButtonElement).click());
		await act(async () => (zoomOut as HTMLButtonElement).click());
		expect(card(view.container, "thread-notes").innerHTML).toContain(
			"relative flex h-7"
		);
		expect(card(view.container, "thread-notes").textContent).not.toContain(
			"Draft is ready"
		);
		await view.dispose();
	});

	test("arranging by agent files stickies under each lead agent", () => {
		const markup = renderToStaticMarkup(
			canvas({ params: { arrange: "agent", minimap: "auto" } })
		);
		expect(markup).toContain('aria-label="Ada, 3 threads"');
		expect(markup).toContain('aria-label="No agent, 1 thread"');
	});

	test("shows a skeleton while loading and an empty state with no threads", () => {
		const loadingMarkup = renderToStaticMarkup(canvas({ loading: true }));
		expect(loadingMarkup).toContain('aria-busy="true"');
		expect(loadingMarkup).not.toContain('data-testid="canvas-card"');
		const emptyMarkup = renderToStaticMarkup(
			canvas({ snapshot: { ...SNAPSHOT, agents: [], threads: [] } })
		);
		expect(emptyMarkup).toContain("Nothing on the canvas yet");
		expect(emptyMarkup).toContain("Add an agent");
	});

	test("shows the host thread view in a side panel", () => {
		const markup = renderToStaticMarkup(
			canvas({
				activeThreadId: "thread-triage",
				threadView: <div data-testid="host-thread-view">Host</div>,
			})
		);
		expect(markup).toContain('data-testid="canvas-thread-panel"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Thread: Crash triage"');
	});

	test("click selects, double-click and Enter open, Escape closes then deselects", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(canvas({ port }));
		const notes = card(view.container, "thread-notes");
		await act(async () => notes.click());
		expect(notes.getAttribute("data-selected")).toBe("true");
		expect(
			view.container.querySelector('[data-testid="canvas-announcer"]')
				?.textContent
		).toContain("Selected:");

		await act(async () => {
			card(view.container, "thread-flaky").dispatchEvent(
				new MouseEvent("dblclick", { bubbles: true })
			);
		});
		expect(calls).toEqual(["open:thread-flaky"]);

		await act(async () => card(view.container, "thread-notes").click());
		await press(card(view.container, "thread-notes"), "Enter");
		expect(calls.at(-1)).toBe("open:thread-notes");

		await view.rerender(
			canvas({
				activeThreadId: "thread-notes",
				port,
				threadView: <div data-testid="host-thread-view" />,
			})
		);
		await press(viewportOf(view.container), "Escape");
		expect(calls.at(-1)).toBe("close");

		await view.rerender(canvas({ activeThreadId: "thread-notes", port }));
		await press(viewportOf(view.container), "Escape");
		expect(view.container.querySelector("[data-selected]")).toBe(null);
		await view.dispose();
	});

	test("arrow keys nudge the selected sticky and the move persists", async () => {
		const view = await mount(canvas());
		const notes = card(view.container, "thread-notes");
		const before = notes.style.transform;
		await act(async () => notes.click());
		await press(notes, "ArrowRight");
		await press(notes, "ArrowDown", { shiftKey: true });
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const home = layout.cards.find((item) => item.id === "thread-notes")?.home;
		expect(home).toBeDefined();
		const expected = { x: (home?.x ?? 0) + 8, y: (home?.y ?? 0) + 40 };
		expect(card(view.container, "thread-notes").style.transform).toBe(
			`translate3d(${expected.x}px, ${expected.y}px, 0)`
		);
		expect(before).not.toBe(
			card(view.container, "thread-notes").style.transform
		);
		const stored = parsePositions(localStorage.getItem(CANVAS_POSITIONS_KEY));
		expect(stored.status["thread-notes"]).toEqual(expected);

		// Reset layout puts it home and clears the override.
		const reset = view.container.querySelector(
			'button[aria-label="Reset layout"]'
		);
		expect(reset instanceof HTMLButtonElement && !reset.disabled).toBe(true);
		await act(async () => (reset as HTMLButtonElement).click());
		expect(card(view.container, "thread-notes").style.transform).toBe(
			`translate3d(${home?.x}px, ${home?.y}px, 0)`
		);
		expect(
			parsePositions(localStorage.getItem(CANVAS_POSITIONS_KEY)).status
		).toEqual({});
		await view.dispose();
	});

	test("restores stored positions and ignores unknown ids", async () => {
		localStorage.setItem(
			CANVAS_POSITIONS_KEY,
			JSON.stringify({
				status: {
					"thread-gone": { x: 9, y: 9 },
					"thread-triage": { x: 1234, y: 567 },
				},
			})
		);
		const view = await mount(canvas());
		expect(card(view.container, "thread-triage").style.transform).toBe(
			"translate3d(1234px, 567px, 0)"
		);
		expect(view.container.querySelectorAll("[data-canvas-card]")).toHaveLength(
			6
		);
		await view.dispose();
	});

	test("a sticky stored outside its frame is drawn lifted", async () => {
		localStorage.setItem(
			CANVAS_POSITIONS_KEY,
			JSON.stringify({ status: { "thread-notes": { x: 9000, y: 9000 } } })
		);
		const view = await mount(canvas());
		expect(card(view.container, "thread-notes").dataset.loose).toBe("true");
		expect(card(view.container, "thread-triage").dataset.loose).toBeUndefined();
		await view.dispose();
	});

	test("keeps working when browser storage throws", async () => {
		const original = Object.getOwnPropertyDescriptor(
			globalThis,
			"localStorage"
		);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get() {
				throw new Error("blocked");
			},
		});
		try {
			const view = await mount(canvas());
			const notes = card(view.container, "thread-notes");
			await act(async () => notes.click());
			await press(notes, "ArrowLeft");
			expect(
				view.container.querySelectorAll("[data-canvas-card]")
			).toHaveLength(6);
			await view.dispose();
		} finally {
			if (original) {
				Object.defineProperty(globalThis, "localStorage", original);
			}
		}
	});

	test("dragging a sticky moves it in world units", async () => {
		const view = await mount(canvas());
		const triage = card(view.container, "thread-triage");
		const home = buildCanvasLayout(SNAPSHOT, "status").cards.find(
			(item) => item.id === "thread-triage"
		)?.home;
		await pointer(triage, "pointerdown", 100, 100);
		await pointer(window, "pointermove", 140, 160);
		await pointer(window, "pointerup", 140, 160);
		expect(card(view.container, "thread-triage").style.transform).toBe(
			`translate3d(${(home?.x ?? 0) + 40}px, ${(home?.y ?? 0) + 60}px, 0)`
		);
		expect(
			parsePositions(localStorage.getItem(CANVAS_POSITIONS_KEY)).status[
				"thread-triage"
			]
		).toEqual({ x: (home?.x ?? 0) + 40, y: (home?.y ?? 0) + 60 });
		await view.dispose();
	});

	test("dragging empty canvas pans the world layer", async () => {
		const view = await mount(canvas());
		const world = view.container.querySelector('[data-testid="canvas-world"]');
		const before = world instanceof HTMLElement ? world.style.transform : "";
		const viewport = viewportOf(view.container);
		await pointer(viewport, "pointerdown", 10, 10);
		await pointer(window, "pointermove", 60, 40);
		await pointer(window, "pointerup", 60, 40);
		const after = world instanceof HTMLElement ? world.style.transform : "";
		expect(after).not.toBe(before);
		expect(after).toContain("translate3d(50px, 30px, 0)");
		await view.dispose();
	});

	test("zoom buttons step the zoom and report it", async () => {
		const view = await mount(canvas());
		const zoomIn = view.container.querySelector('button[aria-label="Zoom in"]');
		await act(async () => (zoomIn as HTMLButtonElement).click());
		const label = view.container.querySelector(
			'button[aria-label^="Zoom 125%"]'
		);
		expect(label?.textContent).toBe("125%");
		await view.dispose();
	});

	test("double-clicking empty canvas writes a new thread only on submit", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(canvas({ port }));
		await act(async () => {
			viewportOf(view.container).dispatchEvent(
				new MouseEvent("dblclick", {
					bubbles: true,
					clientX: 400,
					clientY: 300,
				})
			);
		});
		const dialog = view.container.querySelector(
			'[data-testid="canvas-composer"]'
		);
		expect(dialog).not.toBe(null);
		expect(dialog?.getAttribute("role")).toBe("dialog");

		// Closing never sends.
		const close = dialog?.querySelector('button[aria-label="Close"]');
		await act(async () => (close as HTMLButtonElement).click());
		expect(
			view.container.querySelector('[data-testid="canvas-composer"]')
		).toBe(null);
		expect(calls).toEqual([]);

		// "N" opens it again; pick Grace, type, and submit.
		await press(viewportOf(view.container), "n");
		const composer = view.container.querySelector(
			'[data-testid="canvas-composer"]'
		);
		const picker = composer?.querySelector(
			'[data-testid="canvas-composer-agents"]'
		);
		if (!(picker instanceof HTMLSelectElement)) {
			throw new Error("No agent picker");
		}
		expect(picker.getAttribute("aria-label")).toBe("Agent");
		expect(picker.selectedOptions[0]?.textContent).toBe("Any agent");
		const grace = [...picker.options].find(
			(option) => option.textContent === "Grace"
		);
		expect(grace).toBeDefined();
		await act(async () => {
			picker.value = grace?.value ?? "";
			picker.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(picker.selectedOptions[0]?.textContent).toBe("Grace");
		const field = composer?.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("No composer field");
		}
		await typeInto(field, "  Look at the new crash  ");
		expect(field.value).toBe("  Look at the new crash  ");
		await press(field, "Enter");
		expect(calls).toEqual([
			'start:{"agentId":"agent-grace","prompt":"Look at the new crash"}',
		]);
		expect(
			view.container.querySelector('[data-testid="canvas-composer"]')
		).toBe(null);

		// The host creates the thread: it lands where the note was written.
		const created = thread({
			agentIds: ["agent-grace"],
			id: "thread-new",
			lastMessageRole: "user",
			running: true,
			title: "Look at the new crash",
			updatedAt: ago(0),
		});
		await view.rerender(
			canvas({
				port,
				snapshot: { ...SNAPSHOT, threads: [created, ...SNAPSHOT.threads] },
			})
		);
		const stored = parsePositions(localStorage.getItem(CANVAS_POSITIONS_KEY));
		expect(stored.status["thread-new"]).toBeDefined();
		expect(
			card(view.container, "thread-new").getAttribute("data-selected")
		).toBe("true");
		await view.dispose();
	});

	test("the header switches the arrangement locally", async () => {
		const view = await mount(canvas());
		const agent = [...view.container.querySelectorAll("button")].find(
			(item) => item.textContent === "Agent"
		);
		await act(async () => agent?.click());
		expect(agent?.getAttribute("aria-pressed")).toBe("true");
		const labels = [
			...view.container.querySelectorAll('[data-testid="canvas-frame"]'),
		].map((frame) => frame.getAttribute("aria-label"));
		expect(labels).toEqual([
			"Ada, 3 threads",
			"Grace, 2 threads",
			"No agent, 1 thread",
		]);
		await view.dispose();
	});

	test("an open sticky keeps its age and marks itself inside its own bounds", async () => {
		const view = await mount(
			canvas({
				activeThreadId: "thread-triage",
				threadView: <div data-testid="host-thread-view" />,
			})
		);
		const fills = view.container.querySelectorAll(
			'[data-testid="canvas-open-fill"]'
		);
		expect(fills).toHaveLength(1);
		expect(fills[0]?.closest('[data-canvas-card="thread-triage"]')).not.toBe(
			null
		);
		expect(fills[0]?.closest("[data-canvas-card] > span")).not.toBe(null);
		const triage = card(view.container, "thread-triage");
		expect(triage.textContent).not.toContain("Open");
		expect(triage.getAttribute("aria-label")).toContain("open");
		await view.dispose();
	});

	test("stickies tab in frame order, then reading order inside a frame", async () => {
		const view = await mount(canvas());
		const cards = [
			...view.container.querySelectorAll<HTMLElement>("[data-canvas-card]"),
		];
		const ranks = cards.map((element) =>
			THREAD_STATUS_ORDER.indexOf(
				element.getAttribute("data-status") as ThreadStatus
			)
		);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		for (const frame of layout.frames) {
			const homes = cards
				.map((element) => element.getAttribute("data-canvas-card"))
				.map((id) => layout.cards.find((item) => item.id === id))
				.filter((item) => item?.frameId === frame.id)
				.map((item) => item?.home ?? { x: 0, y: 0 });
			const reading = [...homes].sort((a, b) => a.y - b.y || a.x - b.x);
			expect(homes).toEqual(reading);
		}
		await view.dispose();
	});

	test("the status view never repeats a frame's status on its stickies", async () => {
		const view = await mount(canvas());
		for (const element of view.container.querySelectorAll(
			"[data-canvas-card]"
		)) {
			const status = element.getAttribute("data-status") as ThreadStatus;
			if (status === "attention") {
				continue;
			}
			expect(element.textContent).not.toContain(THREAD_STATUS_LABELS[status]);
		}
		await view.dispose();
	});

	test("selection is announced politely and leaves with keyboard focus", async () => {
		const view = await mount(canvas());
		const announcer = view.container.querySelector(
			'[data-testid="canvas-announcer"]'
		);
		expect(announcer?.getAttribute("aria-live")).toBe("polite");
		const notes = card(view.container, "thread-notes");
		expect(notes.hasAttribute("aria-current")).toBe(false);
		await act(async () => notes.focus());
		expect(notes.getAttribute("data-selected")).toBe("true");
		expect(announcer?.textContent).toContain("Selected:");

		const statusToggle = [...view.container.querySelectorAll("button")].find(
			(item) => item.textContent === "Status"
		);
		await act(async () => statusToggle?.focus());
		expect(view.container.querySelector("[data-selected]")).toBe(null);
		expect(announcer?.textContent).toBe("");

		// A click selection stays put when focus moves on.
		await act(async () => card(view.container, "thread-notes").click());
		await act(async () => statusToggle?.focus());
		expect(
			card(view.container, "thread-notes").getAttribute("data-selected")
		).toBe("true");
		await view.dispose();
	});

	test("Escape inside the thread panel closes the thread, but not while typing", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			canvas({
				activeThreadId: "thread-triage",
				port,
				threadView: <textarea aria-label="Reply" />,
			})
		);
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("No host field");
		}
		await press(field, "Escape");
		expect(calls).toEqual([]);
		const locate = view.container.querySelector(
			'button[aria-label="Show on canvas"]'
		);
		if (!locate) {
			throw new Error("No locate button");
		}
		await press(locate, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("the zoom percentage opens the zoom menu", () => {
		const markup = renderToStaticMarkup(canvas());
		expect(markup).toContain('aria-label="Zoom 100%, zoom options"');
		expect(markup).toContain('aria-haspopup="menu"');
	});

	test("a sticky dropped onto another slides clear of it", async () => {
		const view = await mount(canvas());
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const triage = layout.cards.find((item) => item.id === "thread-triage");
		const target = layout.cards.find(
			(item) => item.id !== "thread-triage" && item.frameId !== triage?.frameId
		);
		if (!(triage && target)) {
			throw new Error("Fixture lacks two frames");
		}
		const dx = target.home.x - triage.home.x + 30;
		const dy = target.home.y - triage.home.y + 30;
		await pointer(card(view.container, "thread-triage"), "pointerdown", 0, 0);
		await pointer(window, "pointermove", dx / 2, dy / 2);
		await pointer(window, "pointermove", dx, dy);
		await pointer(window, "pointerup", dx, dy);
		const positionOf = (id: string) => {
			const match = card(view.container, id).style.transform.match(
				/translate3d\((-?[\d.]+)px, (-?[\d.]+)px/
			);
			return { x: Number(match?.[1]), y: Number(match?.[2]) };
		};
		const dropped = cardRect(positionOf("thread-triage"));
		expect(dropped).not.toEqual(
			cardRect({ x: triage.home.x + dx, y: triage.home.y + dy })
		);
		for (const other of layout.cards) {
			if (other.id === "thread-triage") {
				continue;
			}
			expect(overlaps(dropped, cardRect(positionOf(other.id)))).toBe(false);
		}
		await view.dispose();
	});
	test("Space, Enter, arrows and +/- keep their native meaning on chrome buttons", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(canvas({ port }));
		const zoomIn = view.container.querySelector('button[aria-label="Zoom in"]');
		if (!(zoomIn instanceof HTMLButtonElement)) {
			throw new Error("No zoom in button");
		}
		const keyOn = async (target: Element, type: string, key: string) => {
			const event = new KeyboardEvent(type, {
				bubbles: true,
				cancelable: true,
				key,
			});
			await act(async () => {
				target.dispatchEvent(event);
			});
			return event.defaultPrevented;
		};
		// A chrome button keeps Space (it presses on keyup) and Enter.
		expect(await keyOn(zoomIn, "keydown", " ")).toBe(false);
		expect(await keyOn(zoomIn, "keyup", " ")).toBe(false);
		// The board swallows Space for Space+drag.
		const viewport = viewportOf(view.container);
		expect(await keyOn(viewport, "keydown", " ")).toBe(true);
		expect(await keyOn(viewport, "keyup", " ")).toBe(true);

		// With a sticky selected, arrows, Enter and "-" on a button do nothing
		// to the board.
		const notes = card(view.container, "thread-notes");
		await act(async () => notes.click());
		const before = notes.style.transform;
		expect(await keyOn(zoomIn, "keydown", "ArrowRight")).toBe(false);
		expect(await keyOn(zoomIn, "keydown", "Enter")).toBe(false);
		expect(await keyOn(zoomIn, "keydown", "-")).toBe(false);
		expect(card(view.container, "thread-notes").style.transform).toBe(before);
		expect(calls).toEqual([]);
		expect(
			view.container.querySelector('button[aria-label^="Zoom 100%"]')
		).not.toBe(null);
		await view.dispose();
	});

	test("double-clicking empty canvas centres the new sticky on the click", async () => {
		const view = await mount(canvas());
		await act(async () => {
			viewportOf(view.container).dispatchEvent(
				new MouseEvent("dblclick", {
					bubbles: true,
					clientX: 5000,
					clientY: 4000,
				})
			);
		});
		// The new sticky is the composer itself, at the sticky's footprint.
		const note = view.container.querySelector(
			'[data-testid="canvas-composer"]'
		);
		expect(note?.getAttribute("data-world")).toBe(
			`${5000 - CARD_WIDTH / 2},${4000 - CARD_HEIGHT / 2}`
		);
		expect(
			view.container.querySelector('[data-testid="canvas-drop-ghost"]')
		).toBe(null);
		await view.dispose();
	});

	test("double-clicking on a crowded spot keeps the new sticky near the click", async () => {
		const view = await mount(canvas());
		const layout = buildCanvasLayout(SNAPSHOT, "status");
		const notes = layout.cards.find((item) => item.id === "thread-notes");
		if (!notes) {
			throw new Error("fixture lacks thread-notes");
		}
		const click = {
			x: notes.home.x + CARD_WIDTH / 2,
			y: notes.home.y + CARD_HEIGHT / 2,
		};
		await act(async () => {
			viewportOf(view.container).dispatchEvent(
				new MouseEvent("dblclick", {
					bubbles: true,
					clientX: click.x,
					clientY: click.y,
				})
			);
		});
		const note = view.container.querySelector(
			'[data-testid="canvas-composer"]'
		);
		const [x, y] = (note?.getAttribute("data-world") ?? "").split(",");
		const centre = {
			x: Number(x) + CARD_WIDTH / 2,
			y: Number(y) + CARD_HEIGHT / 2,
		};
		expect(
			Math.hypot(centre.x - click.x, centre.y - click.y)
		).toBeLessThanOrEqual(96 * Math.SQRT2);
		await view.dispose();
	});

	test("a frame counts only the stickies it still holds", async () => {
		localStorage.setItem(
			CANVAS_POSITIONS_KEY,
			JSON.stringify({ status: { "thread-notes": { x: 9000, y: 9000 } } })
		);
		const view = await mount(canvas());
		const frame = view.container.querySelector(
			'[data-canvas-frame="status:your-turn"]'
		);
		const total =
			buildCanvasLayout(SNAPSHOT, "status").frames.find(
				(item) => item.id === "status:your-turn"
			)?.threadIds.length ?? 0;
		const here = total - 1;
		expect(frame?.getAttribute("aria-label")).toBe(
			`Your turn, ${here} ${here === 1 ? "thread" : "threads"}, 1 moved out`
		);
		expect(
			frame?.querySelector('[data-testid="canvas-frame-moved"]')?.textContent
		).toBe("1 moved");
		await view.dispose();
	});

	test("far out, compact stickies drop their footer for a longer title", async () => {
		const view = await mount(canvas());
		const zoomOut = view.container.querySelector(
			'button[aria-label="Zoom out"]'
		);
		for (const _step of [1, 2, 3, 4]) {
			await act(async () => (zoomOut as HTMLButtonElement).click());
		}
		const notes = card(view.container, "thread-notes");
		expect(notes.innerHTML).toContain("line-clamp-3");
		expect(notes.textContent).not.toContain("Ada");
		await view.dispose();
	});
});
