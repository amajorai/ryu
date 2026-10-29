// Unit tests for the custom-theme focus-ring derivation: WCAG 1.4.11 needs the
// ring at 3:1 against every surface it sits on, so a pale (light mode) or dark
// (dark mode) primary is shifted in lightness only, and a passing primary is
// returned untouched.

import { describe, expect, test } from "bun:test";
import {
	accessibleRingColor,
	colorContrastRatio,
	MIN_RING_CONTRAST,
	parseColorToLinear,
} from "./ring.ts";

function minContrast(color: string, surfaces: string[]): number {
	return Math.min(
		...surfaces.map((surface) => colorContrastRatio(color, surface) ?? 0)
	);
}

const LIGHT_SURFACES = ["#ffffff", "#f9f9f9"];
const DARK_SURFACES = ["#18181b", "#27272a"];

describe("parseColorToLinear", () => {
	test("reads hex, rgb(), hsl() and oklch() as the same white", () => {
		for (const white of [
			"#fff",
			"#ffffff",
			"rgb(255, 255, 255)",
			"hsl(0 0% 100%)",
			"oklch(1 0 0)",
		]) {
			const lin = parseColorToLinear(white);
			expect(lin).not.toBeNull();
			for (const channel of lin ?? []) {
				expect(channel).toBeCloseTo(1, 3);
			}
		}
	});

	test("rejects colours it cannot resolve", () => {
		expect(parseColorToLinear("var(--primary)")).toBeNull();
		expect(parseColorToLinear("teal")).toBeNull();
	});
});

describe("accessibleRingColor", () => {
	test("darkens a pale teal primary in light mode to the 3:1 threshold", () => {
		const ring = accessibleRingColor("#80cbc4", LIGHT_SURFACES, "light");
		expect(ring).not.toBe("#80cbc4");
		const contrast = minContrast(ring, LIGHT_SURFACES);
		expect(contrast).toBeGreaterThanOrEqual(MIN_RING_CONTRAST);
		// Minimum shift: just over the line, not pushed toward black.
		expect(contrast).toBeLessThan(3.2);
	});

	test("darkens a pale orange primary in light mode", () => {
		const surfaces = ["#fafafa", "#f3f4f6"];
		const ring = accessibleRingColor("#ff9940", surfaces, "light");
		expect(minContrast(ring, surfaces)).toBeGreaterThanOrEqual(
			MIN_RING_CONTRAST
		);
		expect(minContrast(ring, surfaces)).toBeLessThan(3.2);
	});

	test("lightens a dark primary in dark mode", () => {
		const ring = accessibleRingColor("#1e3a8a", DARK_SURFACES, "dark");
		const before = parseColorToLinear("#1e3a8a");
		const after = parseColorToLinear(ring);
		expect(before && after).toBeTruthy();
		expect(minContrast(ring, DARK_SURFACES)).toBeGreaterThanOrEqual(
			MIN_RING_CONTRAST
		);
		// Lighter, and still blue-dominant (same hue family).
		expect(after?.[2] ?? 0).toBeGreaterThan(before?.[2] ?? 1);
		expect(after?.[2] ?? 0).toBeGreaterThan(after?.[0] ?? 1);
	});

	test("handles oklch and hsl primaries", () => {
		for (const primary of ["oklch(0.9 0.05 180)", "hsl(30 100% 70%)"]) {
			const ring = accessibleRingColor(primary, ["#ffffff"], "light");
			expect(minContrast(ring, ["#ffffff"])).toBeGreaterThanOrEqual(
				MIN_RING_CONTRAST
			);
		}
	});

	test("returns an already-passing primary unchanged", () => {
		expect(accessibleRingColor("#2563eb", LIGHT_SURFACES, "light")).toBe(
			"#2563eb"
		);
		const oklch = "oklch(0.6690 0.1837 248.81)";
		expect(accessibleRingColor(oklch, DARK_SURFACES, "dark")).toBe(oklch);
	});

	test("leaves unparseable input alone", () => {
		expect(accessibleRingColor("var(--brand)", LIGHT_SURFACES, "light")).toBe(
			"var(--brand)"
		);
		expect(accessibleRingColor("#80cbc4", ["var(--bg)"], "light")).toBe(
			"#80cbc4"
		);
	});
});
