import { describe, expect, test } from "bun:test";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import {
	buildSystem,
	COLUMN_ELEVATION,
	columnFrame,
	columnRoom,
	columnSystem,
	FOV,
	OVERVIEW_AZIMUTH,
	orbitPoint,
} from "./planets-model.ts";

const SNAPSHOT = {
	agents: ["Atlas", "Brook", "Cipher", "Delta", "Echo", "Forge"].map(
		(name) => ({
			avatarUrl: null,
			description: "",
			id: `agent-${name.toLowerCase()}`,
			name,
			status: "idle",
		})
	),
	events: [],
	groups: [],
	threads: [],
	version: 1,
} as unknown as InterfaceSnapshot;

describe("portrait column", () => {
	const system = columnSystem(buildSystem(SNAPSHOT), OVERVIEW_AZIMUTH);
	const toward: [number, number] = [
		Math.sin(OVERVIEW_AZIMUTH),
		Math.cos(OVERVIEW_AZIMUTH),
	];

	test("planets hold still, stacked down the screen from the star", () => {
		expect(system.column).toBe(true);
		let last = Number.NEGATIVE_INFINITY;
		for (const planet of system.planets) {
			expect(planet.orbitSpeed).toBe(0);
			const [x, , z] = orbitPoint(planet.orbitRadius, planet.phase);
			// Toward the camera (down the screen), farther for outer orbits.
			const down = x * toward[0] + z * toward[1];
			expect(down).toBeGreaterThan(last);
			last = down;
		}
	});

	test("they alternate sides of the star's line, close to it", () => {
		const sides = system.planets.map((planet) => {
			const [x, , z] = orbitPoint(planet.orbitRadius, planet.phase);
			return x * toward[1] - z * toward[0];
		});
		for (const [index, side] of sides.entries()) {
			expect(Math.abs(side)).toBeLessThan(3);
			if (index > 0) {
				expect(Math.sign(side)).not.toBe(Math.sign(sides[index - 1] ?? 0));
			}
		}
	});

	test("frames the stack in the room the HUD leaves, closer than the disc", () => {
		const viewport = { height: 844, width: 390 };
		const room = columnRoom(
			{
				card: { bottom: 830, left: 10, right: 380, top: 744 },
				controls: { bottom: 60, left: 330, right: 380, top: 10 },
				legend: null,
			},
			viewport.height
		);
		expect(room.top).toBeGreaterThan(60);
		expect(room.bottom).toBeGreaterThan(844 - 744);
		const frame = columnFrame(system, viewport, FOV, COLUMN_ELEVATION, room);
		expect(frame.distance).toBeGreaterThan(0);
		expect(frame.toward).toBeGreaterThan(0);
		// A sheet below and controls above: the picture shifts to their middle.
		expect(frame.shift[1]).toBeCloseTo((room.top - room.bottom) / 2);
	});
});
