import { beforeEach, describe, expect, it, mock } from "bun:test";
import { WIN_CHANNELS } from "../shared/ipc.ts";
import {
	type IslandPlacement,
	placementForZone,
	TRANSLUCENT_WINDOW_INSET,
} from "../shared/placement.ts";
import {
	dockedAnchor,
	type IslandAnchor,
	RESTING_FOOTPRINT,
	rectAt,
	TRANSLUCENT_WINDOW_SIZE,
	windowOriginFor,
} from "./anchor.ts";
import type { Point, Rect } from "./zones.ts";

const MARGIN = 20;
/** Comfortably past the positioner's 150ms pending-placement timeout. */
const PAST_COMMIT_TIMEOUT_MS = 200;

interface FakeDisplay {
	id: number;
	workArea: Rect;
}

const PRIMARY: FakeDisplay = {
	id: 1,
	workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const SECONDARY: FakeDisplay = {
	id: 2,
	workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
};

let displays: FakeDisplay[] = [PRIMARY, SECONDARY];
let notchGeometry: unknown = null;
const writeStoredAnchor = mock((_anchor: IslandAnchor) => undefined);

function containsPoint(area: Rect, point: Point): boolean {
	return (
		point.x >= area.x &&
		point.y >= area.y &&
		point.x < area.x + area.width &&
		point.y < area.y + area.height
	);
}

mock.module("electron", () => ({
	screen: {
		getAllDisplays: () => displays,
		getPrimaryDisplay: () => PRIMARY,
		getDisplayNearestPoint: (point: Point) =>
			displays.find((display) => containsPoint(display.workArea, point)) ??
			PRIMARY,
	},
}));
mock.module("./notch.ts", () => ({
	getNotchGeometry: () => notchGeometry,
}));
mock.module("./edge-offset.ts", () => ({
	getEdgeOffset: () => MARGIN,
}));
mock.module("./position-store.ts", () => ({
	writeStoredAnchor,
}));

const { IslandPositioner } = await import("./positioner.ts");

/** A BrowserWindow stand-in whose geometry lives in local state. */
function fakeWindow(initial: Rect) {
	const state = { bounds: { ...initial }, destroyed: false };
	return {
		state,
		isDestroyed: mock(() => state.destroyed),
		getBounds: mock(() => ({ ...state.bounds })),
		setBounds: mock((rect: Rect) => {
			state.bounds = { ...rect };
		}),
		getPosition: mock(() => [state.bounds.x, state.bounds.y]),
		getSize: mock(() => [state.bounds.width, state.bounds.height]),
		setPosition: mock((x: number, y: number) => {
			state.bounds = { ...state.bounds, x, y };
		}),
		webContents: { send: mock((_channel: string, _value: unknown) => 0) },
		once: mock(() => undefined),
	};
}

type FakeWindow = ReturnType<typeof fakeWindow>;
type Positioner = InstanceType<typeof IslandPositioner>;

const BOTTOM_RIGHT = placementForZone(8);
const TOP_LEFT = placementForZone(0);

function originFor(rect: Rect, placement: IslandPlacement): Point {
	return windowOriginFor(
		rect,
		placement,
		TRANSLUCENT_WINDOW_SIZE,
		TRANSLUCENT_WINDOW_INSET
	);
}

/** A positioner docked bottom-right on `display`, window already in place. */
function setup(
	material: boolean,
	display: FakeDisplay = PRIMARY
): { win: FakeWindow; positioner: Positioner; anchor: IslandAnchor } {
	const anchor = dockedAnchor(
		display.workArea,
		BOTTOM_RIGHT,
		RESTING_FOOTPRINT,
		MARGIN
	);
	const rect = rectAt(anchor, RESTING_FOOTPRINT);
	const initial = material
		? rect
		: { ...originFor(rect, BOTTOM_RIGHT), ...TRANSLUCENT_WINDOW_SIZE };
	const win = fakeWindow(initial);
	const positioner = new IslandPositioner(
		win as unknown as ConstructorParameters<typeof IslandPositioner>[0],
		material,
		anchor,
		RESTING_FOOTPRINT
	);
	return { win, positioner, anchor };
}

beforeEach(() => {
	displays = [PRIMARY, SECONDARY];
	notchGeometry = null;
	writeStoredAnchor.mockClear();
});

describe("IslandPositioner translucent drop", () => {
	it("waits for the renderer before moving to a new placement", () => {
		const { win, positioner } = setup(false);
		positioner.drop(PRIMARY.workArea, 0);

		expect(win.webContents.send).toHaveBeenCalledTimes(1);
		expect(win.webContents.send).toHaveBeenCalledWith(
			WIN_CHANNELS.placement,
			TOP_LEFT
		);
		expect(writeStoredAnchor).toHaveBeenCalledTimes(1);
		expect(writeStoredAnchor.mock.calls[0]?.[0].placement).toEqual(TOP_LEFT);
		expect(win.setPosition).not.toHaveBeenCalled();

		positioner.commitPlacement(placementForZone(0));
		expect(win.setPosition).toHaveBeenCalledTimes(1);
		const expected = originFor(positioner.targetRect(), TOP_LEFT);
		expect(win.setPosition).toHaveBeenCalledWith(expected.x, expected.y);
		positioner.dispose();
	});

	it("ignores a commit for a different or already-committed placement", () => {
		const { win, positioner } = setup(false);
		positioner.drop(PRIMARY.workArea, 0);

		positioner.commitPlacement(BOTTOM_RIGHT);
		expect(win.setPosition).not.toHaveBeenCalled();

		positioner.commitPlacement(TOP_LEFT);
		expect(win.setPosition).toHaveBeenCalledTimes(1);
		positioner.commitPlacement(TOP_LEFT);
		expect(win.setPosition).toHaveBeenCalledTimes(1);
		positioner.dispose();
	});

	it("moves on its own when the renderer never acknowledges", async () => {
		const { win, positioner } = setup(false);
		positioner.drop(PRIMARY.workArea, 0);
		expect(win.setPosition).not.toHaveBeenCalled();

		await Bun.sleep(PAST_COMMIT_TIMEOUT_MS);
		expect(win.setPosition).toHaveBeenCalledTimes(1);
		const expected = originFor(positioner.targetRect(), TOP_LEFT);
		expect(win.setPosition).toHaveBeenCalledWith(expected.x, expected.y);
		positioner.dispose();
	});

	it("settles a pending placement when a drag begins", async () => {
		const { win, positioner } = setup(false);
		positioner.drop(PRIMARY.workArea, 0);

		positioner.beginDrag();
		expect(win.setPosition).toHaveBeenCalledTimes(1);

		// The timeout was cleared with the pending placement: no second move.
		await Bun.sleep(PAST_COMMIT_TIMEOUT_MS);
		expect(win.setPosition).toHaveBeenCalledTimes(1);
		positioner.dispose();
	});

	it("drops a pending move when disposed", async () => {
		const { win, positioner } = setup(false);
		positioner.drop(PRIMARY.workArea, 0);
		positioner.dispose();

		await Bun.sleep(PAST_COMMIT_TIMEOUT_MS);
		expect(win.setPosition).not.toHaveBeenCalled();
	});
});

describe("IslandPositioner rehome", () => {
	it("keeps the anchor while its display exists", () => {
		const { win, positioner, anchor } = setup(false, SECONDARY);
		positioner.rehome();

		expect(writeStoredAnchor).not.toHaveBeenCalled();
		expect(win.webContents.send).not.toHaveBeenCalled();
		const expected = originFor(rectAt(anchor, RESTING_FOOTPRINT), BOTTOM_RIGHT);
		expect(win.setPosition).toHaveBeenCalledTimes(1);
		expect(win.setPosition).toHaveBeenCalledWith(expected.x, expected.y);
	});

	it("re-docks onto a remaining display after its display is removed", () => {
		const { win, positioner } = setup(false, SECONDARY);
		displays = [PRIMARY];
		positioner.rehome();

		const redocked = dockedAnchor(
			PRIMARY.workArea,
			BOTTOM_RIGHT,
			RESTING_FOOTPRINT,
			MARGIN
		);
		expect(writeStoredAnchor).toHaveBeenCalledTimes(1);
		expect(writeStoredAnchor).toHaveBeenCalledWith(redocked);
		// Same placement: no renderer round-trip, the window moves right away.
		expect(win.webContents.send).not.toHaveBeenCalled();
		const expected = originFor(
			rectAt(redocked, RESTING_FOOTPRINT),
			BOTTOM_RIGHT
		);
		expect(win.setPosition).toHaveBeenCalledWith(expected.x, expected.y);
	});
});

describe("IslandPositioner inactive windows", () => {
	it("ignores drop and footprint changes once destroyed", () => {
		const { win, positioner } = setup(false);
		win.state.destroyed = true;

		positioner.drop(PRIMARY.workArea, 0);
		expect(positioner.setFootprint({ width: 400, height: 480 })).toBeNull();
		expect(win.webContents.send).not.toHaveBeenCalled();
		expect(writeStoredAnchor).not.toHaveBeenCalled();
		expect(win.setPosition).not.toHaveBeenCalled();
		expect(win.setBounds).not.toHaveBeenCalled();
	});

	it("ignores drop and footprint changes in notch mode", () => {
		const { win, positioner } = setup(true);
		notchGeometry = { x: 0, y: 0, width: 200, height: 32 };

		positioner.drop(PRIMARY.workArea, 0);
		expect(positioner.setFootprint({ width: 400, height: 480 })).toBeNull();
		expect(win.webContents.send).not.toHaveBeenCalled();
		expect(writeStoredAnchor).not.toHaveBeenCalled();
		expect(win.setPosition).not.toHaveBeenCalled();
		expect(win.setBounds).not.toHaveBeenCalled();
	});
});

describe("IslandPositioner material drop", () => {
	it("moves immediately with no pending placement", async () => {
		const { win, positioner } = setup(true);
		positioner.drop(PRIMARY.workArea, 0);

		expect(win.webContents.send).toHaveBeenCalledWith(
			WIN_CHANNELS.placement,
			TOP_LEFT
		);
		expect(writeStoredAnchor).toHaveBeenCalledTimes(1);
		expect(win.setBounds).toHaveBeenCalledTimes(1);
		const target = positioner.targetRect();
		expect(win.setBounds).toHaveBeenCalledWith(target);
		expect(target.x).toBe(PRIMARY.workArea.x + MARGIN);
		expect(target.y).toBe(PRIMARY.workArea.y + MARGIN);

		await Bun.sleep(PAST_COMMIT_TIMEOUT_MS);
		expect(win.setBounds).toHaveBeenCalledTimes(1);
		expect(win.setPosition).not.toHaveBeenCalled();
	});
});
