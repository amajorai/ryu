import { describe, expect, test } from "bun:test";
import { parseAnnouncementVisualCode } from "./announcement-visual.tsx";

describe("authored announcement scene decoding", () => {
	test("retains valid layers beside malformed and future entries", () => {
		const scene = parseAnnouncementVisualCode(
			JSON.stringify({
				version: 1,
				layers: [
					null,
					4,
					[],
					{ type: "future" },
					{ type: "rings", color: "#abc", size: 120 },
				],
			})
		);
		expect(scene).toEqual({
			version: 1,
			layers: [
				{
					type: "rings",
					color: "#abc",
					size: 120,
					count: 3,
					duration: 9,
					opacity: 0.55,
				},
			],
		});
	});
	test("defaults fields independently without discarding the layer", () => {
		const scene = parseAnnouncementVisualCode(
			'{"version":1,"layers":[{"type":"rings","size":1e400,"count":null,"duration":false,"color":4,"opacity":0.25,"future":1e400}]}',
			"#123456"
		);
		expect(scene).toEqual({
			version: 1,
			layers: [
				{
					type: "rings",
					color: "#123456",
					size: 190,
					count: 3,
					duration: 9,
					opacity: 0.25,
				},
			],
		});
	});
	test("bounds point count before skipping invalid points", () => {
		const points = Array.from({ length: 32 }, () => null);
		const scene = parseAnnouncementVisualCode(
			JSON.stringify({
				version: 1,
				layers: [{ type: "particles", points: [...points, { x: 10, y: 20 }] }],
			}),
			"#abc"
		);
		expect(scene?.layers[0]).toEqual({
			type: "particles",
			color: "#abc",
			duration: 4,
			points: [
				{ color: "#abc", delay: 0, size: 4, x: 17, y: 29 },
				{ color: "#abc", delay: 0.45, size: 6, x: 78, y: 23 },
				{ color: "#abc", delay: 0.9, size: 3, x: 66, y: 76 },
				{ color: "#abc", delay: 1.35, size: 5, x: 28, y: 78 },
				{ color: "#abc", delay: 1.8, size: 3, x: 48, y: 16 },
			],
		});
	});
	test("derives delay from accepted points and retains independent coordinates", () => {
		const scene = parseAnnouncementVisualCode(
			JSON.stringify({
				version: 1,
				layers: [
					{
						type: "particles",
						points: [
							null,
							{ x: 0, y: 999, color: " #abc ", size: 20 },
							{ x: 12, y: 15, delay: "invalid" },
						],
					},
				],
			}),
			"#fff"
		);
		expect(scene?.layers[0]).toEqual({
			type: "particles",
			color: "#fff",
			duration: 4,
			points: [
				{ color: "#abc", delay: 0, size: 14, x: 4, y: 92 },
				{ color: "#fff", delay: 0.12, size: 4, x: 12, y: 15 },
			],
		});
	});
	test("requires the real version and layers envelope", () => {
		for (const value of [
			null,
			undefined,
			"",
			"bad",
			"null",
			"[]",
			'{"version":2,"layers":[]}',
			'{"version":1,"layers":null}',
		]) {
			expect(parseAnnouncementVisualCode(value)).toBeNull();
		}
	});
	test("retains a valid empty scene", () => {
		expect(parseAnnouncementVisualCode('{"version":1,"layers":[]}')).toEqual({
			version: 1,
			layers: [],
		});
	});
});
