import { describe, expect, test } from "bun:test";
import {
	CARD_HALF_THICKNESS_PX,
	CARD_SLICES,
	EDGE_METAL,
	EDGE_METAL_STOPS,
	edgeSliceFill,
	edgeStopLuminance,
	sliceDepths,
} from "./pass-edge.ts";

/**
 * The card's milled edge has now regressed TWICE into the same report — "it
 * reads as two cards stacked, joined at the waist" — and both times the cause
 * was visible in the arithmetic below rather than in anything React did.
 *
 * The first time, the lengthwise ramp was symmetric (bright, DARK, bright), so a
 * grey band sat across the exact middle of the edge. The second time, a merge
 * kept that fix but dropped `edgeSliceFill`, so every slice of the thickness
 * painted the identical column and the edge had no shading ACROSS itself — which
 * leaves the two face rings as the only depth cue and reads, again, as two
 * cards.
 *
 * These tests assert those two properties directly. They are deliberately
 * structural rather than snapshot-shaped: a snapshot would have to be updated by
 * whoever retunes the ramp, and "update the snapshot" is not a decision anyone
 * makes carefully.
 */

describe("edge metal ramp", () => {
	test("has ONE specular peak — no dark band across the middle", () => {
		const luminance = EDGE_METAL_STOPS.map((stop) =>
			edgeStopLuminance(stop.color)
		);
		// Count direction changes from rising to falling. A single rolled edge lit
		// by a single light has exactly one; the ramp that made the card read as
		// two had two peaks with a trough between them.
		let peaks = 0;
		for (let i = 1; i < luminance.length - 1; i++) {
			// The loop bounds keep all three indices inside the dense producer map.
			const previous = luminance[i - 1]!;
			const current = luminance[i]!;
			const next = luminance[i + 1]!;
			if (current > previous && current >= next) {
				peaks++;
			}
		}
		expect(peaks).toBe(1);
	});

	test("puts that peak in the upper half of the edge", () => {
		const brightest = EDGE_METAL_STOPS.reduce((best, stop) =>
			edgeStopLuminance(stop.color) > edgeStopLuminance(best.color)
				? stop
				: best
		);
		expect(brightest.at).toBeLessThan(50);
	});

	test("stops are ordered and span the whole band", () => {
		expect(EDGE_METAL_STOPS.at(0)?.at).toBe(0);
		expect(EDGE_METAL_STOPS.at(-1)?.at).toBe(100);
		for (let i = 1; i < EDGE_METAL_STOPS.length; i++) {
			expect(EDGE_METAL_STOPS[i]!.at).toBeGreaterThan(
				EDGE_METAL_STOPS[i - 1]!.at
			);
		}
	});

	test("the CSS gradient is built FROM the stops, not typed twice", () => {
		// `pass-studio/scene.ts` paints the same edge to a canvas off the same
		// array. The duplicate it used to hold silently kept the pre-fix ramp.
		for (const stop of EDGE_METAL_STOPS) {
			expect(EDGE_METAL).toContain(`${stop.color} ${stop.at}%`);
		}
	});
});

describe("edgeSliceFill", () => {
	test("shades each slice by its own depth — the regression that keeps happening", () => {
		const fills = sliceDepths().map((depth) => edgeSliceFill(depth, false));
		// The failure mode is EVERY slice painting the identical column.
		expect(new Set(fills).size).toBeGreaterThan(1);
	});

	test("shoulders sit in shadow and the core catches the light", () => {
		const core = edgeSliceFill(0, false);
		const shoulder = edgeSliceFill(CARD_HALF_THICKNESS_PX, false);
		expect(core).not.toBe(shoulder);
		// At the core there is no shadow layer weight and full sheen; at the
		// shoulder the opposite. Read each layer's alpha straight out of the
		// string — the near-black layer is the shadow, the white one the sheen.
		const alphaOf = (fill: string, rgb: string) =>
			Number.parseFloat(
				new RegExp(`rgba\\(${rgb},\\s*([\\d.]+)\\)`).exec(fill)?.[1] ?? "NaN"
			);
		const SHADOW_RGB = "10, 10, 14";
		const SHEEN_RGB = "255, 255, 255";
		expect(alphaOf(shoulder, SHADOW_RGB)).toBeGreaterThan(
			alphaOf(core, SHADOW_RGB)
		);
		expect(alphaOf(core, SHEEN_RGB)).toBeGreaterThan(
			alphaOf(shoulder, SHEEN_RGB)
		);
	});

	test("the ramp is the LAST layer, under the depth tint", () => {
		// Background layers paint first-on-top, so the metal must come last or the
		// shade and sheen are painted underneath it and do nothing.
		expect(edgeSliceFill(0, false).endsWith(EDGE_METAL)).toBe(true);
		expect(edgeSliceFill(1, true).endsWith(EDGE_METAL)).toBe(true);
	});

	test("a live edge adds iridescence across the core; a brushed one does not", () => {
		const brushed = edgeSliceFill(0, false);
		const live = edgeSliceFill(0, true);
		expect(live).not.toBe(brushed);
		expect(live).toContain("rgba(255, 122, 190");
		expect(brushed).not.toContain("rgba(255, 122, 190");
		// Not just the middle plane: every slice short of the shoulder is tinted,
		// which is what keeps the thickness the same material as the ring.
		expect(edgeSliceFill(1, true)).toContain("rgba(255, 122, 190");
	});
});

describe("slice geometry", () => {
	test("no slice is coplanar with a face", () => {
		for (const depth of sliceDepths()) {
			expect(Math.abs(depth)).toBeLessThan(CARD_HALF_THICKNESS_PX);
		}
	});

	test("the stack fills the thickness with no visible gap at either face", () => {
		const depths = sliceDepths();
		expect(depths).toHaveLength(CARD_SLICES);
		const outermost = Math.max(...depths.map(Math.abs));
		// A full empty pixel against each face is the other half of "two cards
		// back to back"; anything under a pixel the compositor blends away.
		expect(CARD_HALF_THICKNESS_PX - outermost).toBeLessThan(1);
	});

	test("is symmetric about the mid-plane and includes it", () => {
		const depths = sliceDepths();
		expect(depths).toContain(0);
		// `+ 0` normalises the `-0` that negating the mid-plane produces; `toEqual`
		// distinguishes the two and would fail on a stack that IS symmetric.
		expect(depths.map((depth) => -depth + 0).reverse()).toEqual(depths);
	});
});
