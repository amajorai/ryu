import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placementForZone } from "../shared/placement.ts";
import {
	dockedAnchor,
	type IslandAnchor,
	legacyAnchor,
	RESTING_FOOTPRINT,
} from "./anchor.ts";
import type { Rect } from "./zones.ts";

const MARGIN = 20;

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
const userData = mkdtempSync(join(tmpdir(), "island-position-"));
const positionFile = join(userData, "island", "window.json");

mock.module("electron", () => ({
	app: { getPath: () => userData },
	screen: {
		getAllDisplays: () => displays,
		getPrimaryDisplay: () => PRIMARY,
	},
}));
mock.module("./notch.ts", () => ({ getNotchGeometry: () => null }));
mock.module("./edge-offset.ts", () => ({ getEdgeOffset: () => MARGIN }));

const { initialAnchor } = await import("./position.ts");
const { writeStoredAnchor } = await import("./position-store.ts");

function writeRaw(value: unknown): void {
	mkdirSync(join(userData, "island"), { recursive: true });
	writeFileSync(positionFile, JSON.stringify(value), "utf8");
}

beforeEach(() => {
	displays = [PRIMARY, SECONDARY];
	rmSync(join(userData, "island"), { force: true, recursive: true });
});

afterAll(() => {
	rmSync(userData, { force: true, recursive: true });
});

describe("initialAnchor", () => {
	it("docks bottom-right of the primary display when nothing is persisted", () => {
		const expected = dockedAnchor(
			PRIMARY.workArea,
			placementForZone(8),
			RESTING_FOOTPRINT,
			MARGIN
		);
		expect(initialAnchor(false)).toEqual(expected);
		expect(expected.placement).toEqual({ h: "end", v: "end" });
		expect(expected.x).toBe(1920 - MARGIN);
		expect(expected.y).toBe(1040 - MARGIN);
	});

	it("restores the anchor written by a previous session on the secondary display", () => {
		const saved: IslandAnchor = {
			x: 2400,
			y: 300,
			placement: { h: "start", v: "start" },
		};
		writeStoredAnchor(saved);
		expect(initialAnchor(false)).toEqual(saved);
		expect(initialAnchor(true)).toEqual(saved);
	});

	it("re-docks a stored anchor to the same zone on the nearest display once its monitor is gone", () => {
		writeStoredAnchor({
			x: 2400,
			y: 300,
			placement: { h: "start", v: "start" },
		});
		displays = [PRIMARY];
		expect(initialAnchor(false)).toEqual(
			dockedAnchor(
				PRIMARY.workArea,
				{ h: "start", v: "start" },
				RESTING_FOOTPRINT,
				MARGIN
			)
		);
	});

	it("migrates a legacy window-origin record into an anchor", () => {
		writeRaw({ x: 1500, y: 900 });
		const areas = displays.map((display) => display.workArea);
		const translucent = initialAnchor(false);
		expect(translucent).toEqual(
			legacyAnchor({ x: 1500, y: 900 }, false, areas)
		);
		// Translucent windows center the resting footprint in a 600px-wide window.
		expect(translucent.placement).toEqual({ h: "end", v: "end" });
		expect(initialAnchor(true)).toEqual(
			legacyAnchor({ x: 1500, y: 900 }, true, areas)
		);
		expect(initialAnchor(true)).not.toEqual(translucent);
	});

	it("falls back to the default dock when the stored file is corrupt", () => {
		mkdirSync(join(userData, "island"), { recursive: true });
		writeFileSync(positionFile, "{not json", "utf8");
		expect(initialAnchor(false)).toEqual(
			dockedAnchor(
				PRIMARY.workArea,
				placementForZone(8),
				RESTING_FOOTPRINT,
				MARGIN
			)
		);
	});
});
