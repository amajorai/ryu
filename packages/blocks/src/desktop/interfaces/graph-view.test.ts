import { describe, expect, test } from "bun:test";
import type { GraphNode, InterfaceThread } from "@ryuhq/protocol/interfaces";
import {
	agentSubLabel,
	arrowDirection,
	frameViewport,
	type GraphFrameLimits,
	graphBounds,
	labelScale,
	mirroredAround,
	nearestInDirection,
	urgentStatus,
	viewportAvoiding,
} from "./graph-view.ts";

function node(
	overrides: Partial<GraphNode> & Pick<GraphNode, "id">
): GraphNode {
	return {
		kind: "agent",
		label: overrides.id,
		refId: overrides.id,
		status: "idle",
		threadCount: 0,
		x: 0,
		y: 0,
		...overrides,
	};
}

function thread(overrides: Partial<InterfaceThread>): InterfaceThread {
	return {
		agentIds: [],
		id: "thread",
		lastMessage: null,
		lastMessageRole: null,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: "Thread",
		updatedAt: "2026-10-01T00:00:00.000Z",
		...overrides,
	} as InterfaceThread;
}

describe("graphBounds", () => {
	test("covers node footprints and the agent name below the avatar", () => {
		const bounds = graphBounds(
			[
				node({ id: "you", kind: "you", refId: null }),
				node({ id: "a", x: 200, y: 100 }),
			],
			new Set()
		);
		// You: 80px circle. Agent at (200, 100): 48px avatar, a 128px-wide
		// name line centered under it, 44px of label below the avatar.
		expect(bounds).toEqual({ height: 208, width: 304, x: -40, y: -40 });
	});

	test("limits the box to the requested ids and returns null for none", () => {
		const nodes = [node({ id: "a", x: 0, y: -100 }), node({ id: "b", x: 400 })];
		// Names always sit below the avatar, even straight above the hub.
		expect(graphBounds(nodes, new Set(["a"]))).toEqual({
			height: 96,
			width: 128,
			x: -64,
			y: -128,
		});
		expect(graphBounds(nodes, new Set(["missing"]))).toBeNull();
	});
});

describe("frameViewport", () => {
	const limits: GraphFrameLimits = {
		fitMaxZoom: 1,
		focusMaxZoom: 1,
		gap: 28,
		minZoom: 0.25,
		narrowWidth: 480,
		readableZoom: 0.7,
	};
	const ring = [
		node({ id: "you", kind: "you", refId: null }),
		node({ id: "a", x: 0, y: -220 }),
		node({ id: "b", x: 190, y: -110 }),
		node({ id: "c", x: -190, y: 110 }),
		node({ id: "t", kind: "team", x: -346, y: -200 }),
	];
	/** The framed map's screen box, to check nothing is cropped. */
	function screenBox(width: number, height: number) {
		const viewport = frameViewport(
			{ allNodes: ring, focusIds: [], height, overlays: [], width },
			limits
		);
		const bounds = graphBounds(ring, new Set());
		if (!(viewport && bounds)) {
			throw new Error("Expected a frame");
		}
		return {
			left: viewport.x + bounds.x * viewport.zoom,
			right: viewport.x + (bounds.x + bounds.width) * viewport.zoom,
			viewport,
		};
	}

	test("refits the whole map when the canvas narrows (a panel opens)", () => {
		const wide = screenBox(1440, 900);
		const narrowed = screenBox(700, 900);
		expect(narrowed.viewport.zoom).toBeLessThan(wide.viewport.zoom);
		for (const [box, width] of [
			[wide, 1440],
			[narrowed, 700],
		] as const) {
			expect(box.left).toBeGreaterThanOrEqual(28);
			expect(box.right).toBeLessThanOrEqual(width - 28);
		}
	});

	test("centers the map on you", () => {
		const { viewport } = screenBox(1100, 900);
		// You (0, 0) lands on the horizontal center of the canvas.
		expect(viewport.x).toBeCloseTo(550, 5);
	});

	test("frames the whole map on a phone-width canvas, labels included", () => {
		const viewport = frameViewport(
			{ allNodes: ring, focusIds: [], height: 800, overlays: [], width: 390 },
			limits
		);
		if (!viewport) {
			throw new Error("Expected a frame");
		}
		// Zoomed out past 85%, names grow to stay legible; the frame counts
		// the grown labels, so nothing is cut at either side.
		const scale = labelScale(viewport.zoom);
		expect(scale).toBeGreaterThan(1);
		const bounds = graphBounds(ring, new Set(), scale);
		if (!bounds) {
			throw new Error("Expected bounds");
		}
		const left = viewport.x + bounds.x * viewport.zoom;
		const right = viewport.x + (bounds.x + bounds.width) * viewport.zoom;
		expect(left).toBeGreaterThanOrEqual(27.5);
		expect(right).toBeLessThanOrEqual(390 - 27.5);
	});

	test("never magnifies past 100%", () => {
		const viewport = frameViewport(
			{ allNodes: ring, focusIds: [], height: 2000, overlays: [], width: 3000 },
			limits
		);
		expect(viewport?.zoom).toBe(1);
	});

	test("is null before the canvas has a size", () => {
		expect(
			frameViewport(
				{ allNodes: ring, focusIds: [], height: 0, overlays: [], width: 0 },
				limits
			)
		).toBeNull();
	});

	test("mirrors a box around a center line", () => {
		expect(
			mirroredAround({ height: 10, width: 300, x: -200, y: 0 }, 0)
		).toEqual({ height: 10, width: 400, x: -200, y: 0 });
	});
});

describe("viewportAvoiding", () => {
	const bounds = { height: 400, width: 400, x: -200, y: -200 };

	test("centers the bounds when there are no overlays", () => {
		const viewport = viewportAvoiding({
			bounds,
			gap: 0,
			height: 400,
			maxZoom: 2,
			minZoom: 0.1,
			overlays: [],
			width: 800,
		});
		expect(viewport).toEqual({ x: 400, y: 200, zoom: 1 });
	});

	test("clears a corner overlay on the side that costs the least zoom", () => {
		// A wide canvas: stepping right of a top-left legend keeps full zoom,
		// while dropping below it would shrink the map.
		const viewport = viewportAvoiding({
			bounds,
			gap: 0,
			height: 400,
			maxZoom: 2,
			minZoom: 0.1,
			overlays: [{ height: 150, width: 200, x: 0, y: 0 }],
			width: 800,
		});
		expect(viewport.zoom).toBe(1);
		// The framed box starts right of the legend.
		expect(viewport.x + bounds.x * viewport.zoom).toBeGreaterThanOrEqual(200);
	});

	test("never zooms past the limits", () => {
		const viewport = viewportAvoiding({
			bounds: { height: 10, width: 10, x: 0, y: 0 },
			gap: 0,
			height: 1000,
			maxZoom: 1.2,
			minZoom: 0.1,
			overlays: [],
			width: 1000,
		});
		expect(viewport.zoom).toBe(1.2);
	});
});

describe("urgentStatus", () => {
	test("reads the first (most urgent) thread and is null without threads", () => {
		expect(urgentStatus([])).toBeNull();
		expect(
			urgentStatus([thread({ runState: "failed" }), thread({ running: true })])
		).toBe("attention");
	});
});

describe("agentSubLabel", () => {
	test("puts trouble first, then live work, then replies owed", () => {
		expect(
			agentSubLabel({ urgent: "attention", working: true, yourTurn: 2 })?.text
		).toBe("Needs attention");
		expect(
			agentSubLabel({ urgent: "your-turn", working: true, yourTurn: 1 })
		).toEqual({
			spoken: "working, your turn on 1 thread",
			status: "working",
			text: "Working",
		});
		expect(
			agentSubLabel({ urgent: "working", working: true, yourTurn: 0 })?.text
		).toBe("Working");
		expect(
			agentSubLabel({ urgent: "your-turn", working: false, yourTurn: 2 })
		).toEqual({
			spoken: "your turn on 2 threads",
			status: "your-turn",
			text: "Your turn · 2",
		});
		// A single owed reply is spoken but not drawn on the map.
		expect(
			agentSubLabel({ urgent: "your-turn", working: false, yourTurn: 1 })
		).toEqual({
			spoken: "your turn on 1 thread",
			status: "your-turn",
			text: null,
		});
	});

	test("says nothing when no thread needs the user", () => {
		expect(
			agentSubLabel({ urgent: "waiting", working: false, yourTurn: 0 })
		).toBeNull();
	});
});

describe("labelScale", () => {
	test("keeps names at least 11px on screen, growing at most twice", () => {
		expect(labelScale(1)).toBe(1);
		expect(labelScale(0.85)).toBe(1);
		expect(labelScale(0.5)).toBeCloseTo(11 / 6.5, 2);
		expect(labelScale(0.25)).toBe(2);
	});
});

describe("nearestInDirection", () => {
	const nodes = [
		node({ id: "you", kind: "you", refId: null }),
		node({ id: "up", y: -200 }),
		node({ id: "up-right", x: 180, y: -100 }),
		node({ id: "right", x: 200, y: 10 }),
		node({ id: "far-right", x: 600 }),
	];

	test("moves to the nearest node straight ahead", () => {
		expect(nearestInDirection(nodes, "you", "up")).toBe("up");
		expect(nearestInDirection(nodes, "you", "right")).toBe("right");
		expect(nearestInDirection(nodes, "right", "right")).toBe("far-right");
	});

	test("ignores nodes behind or too far to the side, and unknown starts", () => {
		expect(nearestInDirection(nodes, "you", "left")).toBeNull();
		expect(nearestInDirection(nodes, "up", "up")).toBeNull();
		expect(nearestInDirection(nodes, "missing", "up")).toBeNull();
	});

	test("maps only arrow keys to directions", () => {
		expect(arrowDirection("ArrowDown")).toBe("down");
		expect(arrowDirection("Enter")).toBeNull();
	});
});
