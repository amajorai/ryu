import { describe, expect, test } from "bun:test";
import {
	ANIMATED_GRADIENT_PRESET_NAMES,
	ANIMATED_GRADIENT_PRESETS,
	animatedGradientCss,
	DEFAULT_ANIMATED_GRADIENT_PRESET,
	isAnimatedGradientPreset,
	resolveAnimatedGradient,
	toGradientPattern,
} from "./animated-gradient.tsx";

/**
 * The resolver is the ONE place a preset, an author's overrides and a hostile
 * manifest meet, and both renderers read its output — the WebGL field and the
 * static CSS paint every card, every reduced-motion viewer and every lost
 * context falls back to. So these tests are not about the look; they are about
 * the two properties that make the look safe to ship:
 *
 *  1. Nothing unbounded reaches a GPU uniform. `swirlIterations: 1e6` is a loop
 *     the GPU runs — a frozen tab, not an ugly banner.
 *  2. The shader and the static paint cannot disagree, because they are handed
 *     the same resolved object.
 */

describe("the preset table", () => {
	test("the default preset exists and every named preset is complete", () => {
		expect(isAnimatedGradientPreset(DEFAULT_ANIMATED_GRADIENT_PRESET)).toBe(
			true
		);
		expect(ANIMATED_GRADIENT_PRESET_NAMES).toHaveLength(6);
		for (const name of ANIMATED_GRADIENT_PRESET_NAMES) {
			const preset = ANIMATED_GRADIENT_PRESETS[name];
			// A partial preset would resolve half its fields from a spread of
			// `undefined`, which reads as "the author overrode it" downstream.
			for (const value of Object.values(preset)) {
				expect(value).toBeDefined();
			}
			expect(toGradientPattern(preset.shape)).toBe(preset.shape);
		}
	});

	test("an unknown preset name is not accepted, including inherited keys", () => {
		expect(isAnimatedGradientPreset("nope")).toBe(false);
		expect(isAnimatedGradientPreset(undefined)).toBe(false);
		// `Object.hasOwn`, not `in`: `"toString" in obj` is true for every object,
		// so a manifest naming a prototype member would index into a function.
		expect(isAnimatedGradientPreset("toString")).toBe(false);
		expect(isAnimatedGradientPreset("constructor")).toBe(false);
	});
});

describe("shapes are matched against a closed set", () => {
	test("upstream's capitalisation is accepted", () => {
		// The component's own docs write `Checks` / `Stripes` / `Edge`, so an
		// author copying them must not silently get the preset's shape instead.
		expect(toGradientPattern("Checks")).toBe("checks");
		expect(toGradientPattern("  Stripes ")).toBe("stripes");
		expect(toGradientPattern("EDGE")).toBe("edge");
	});

	test("anything else is rejected rather than passed to the shader", () => {
		expect(toGradientPattern("blobs")).toBeNull();
		expect(toGradientPattern(7)).toBeNull();
		expect(toGradientPattern(null)).toBeNull();
	});
});

describe("resolveAnimatedGradient", () => {
	test("no input at all resolves the default preset", () => {
		const prism = ANIMATED_GRADIENT_PRESETS.prism;
		const resolved = resolveAnimatedGradient();
		expect(resolved.colors).toEqual([prism.color1, prism.color2, prism.color3]);
		// Divided by 100 exactly once: the authored `swirl: 80` is uniform `0.8`.
		expect(resolved.swirl).toBeCloseTo(0.8);
		expect(resolved.proportion).toBeCloseTo(0.35);
		expect(resolved.shape).toBe("checks");
	});

	test("an unknown preset falls back rather than resolving undefined", () => {
		expect(
			resolveAnimatedGradient({
				// SAFETY: Deliberately bypass the authored preset union in this
				// malformed-input test; the real resolver must return prism.
				preset: "made-up" as never,
			})
		).toEqual(resolveAnimatedGradient({ preset: "prism" }));
	});

	test("overrides land on top of the preset, leaving the rest alone", () => {
		const vortex = ANIMATED_GRADIENT_PRESETS.vortex;
		const resolved = resolveAnimatedGradient({
			config: { color2: "#123456", speed: 50 },
			preset: "vortex",
		});
		expect(resolved.colors).toEqual([vortex.color1, "#123456", vortex.color3]);
		expect(resolved.speed).toBeCloseTo(0.5);
		// Untouched by the override.
		expect(resolved.swirlIterations).toBe(vortex.swirlIterations);
	});

	test("every hostile number is clamped before it can become a uniform", () => {
		const resolved = resolveAnimatedGradient({
			config: {
				distortion: Number.POSITIVE_INFINITY,
				offset: -1e9,
				proportion: -50,
				rotation: 9999,
				scale: 1e9,
				softness: Number.NaN,
				speed: 1e6,
				swirl: 1e6,
				swirlIterations: 1e6,
			},
		});
		expect(resolved.swirlIterations).toBe(20);
		expect(resolved.scale).toBe(4);
		expect(resolved.rotation).toBe(360);
		expect(resolved.offsetX).toBe(-1);
		expect(resolved.distortion).toBeCloseTo(
			ANIMATED_GRADIENT_PRESETS.prism.distortion / 100
		);
		expect(resolved.softness).toBeCloseTo(
			ANIMATED_GRADIENT_PRESETS.prism.softness / 100
		);
		expect(resolved.proportion).toBe(0);
		expect(resolved.speed).toBe(1);
		expect(resolved.swirl).toBe(1);
	});

	test("swirlIterations is a whole count, not a fraction", () => {
		// It indexes a shader loop; 10.7 passes is not a thing.
		expect(
			resolveAnimatedGradient({ config: { swirlIterations: 10.7 } })
				.swirlIterations
		).toBe(11);
	});

	test("blank colours fall back to the preset ramp, never to an empty list", () => {
		// An empty `colors` array is a shader with nothing to interpolate and a CSS
		// ramp of `transparent` — a black hole where the banner was.
		const resolved = resolveAnimatedGradient({
			config: { color1: "   ", color2: "", color3: undefined },
			preset: "mist",
		});
		const mist = ANIMATED_GRADIENT_PRESETS.mist;
		expect(resolved.colors).toEqual([mist.color1, mist.color2, mist.color3]);
	});
});

describe("animatedGradientCss — the static paint", () => {
	test("keeps all three stops and their order", () => {
		const css = animatedGradientCss(
			resolveAnimatedGradient({
				config: { color1: "#111111", color2: "#222222", color3: "#333333" },
			})
		);
		expect(css).toContain("#111111");
		expect(css).toContain("#222222");
		expect(css).toContain("#333333");
		expect(css.indexOf("#222222")).toBeLessThan(css.lastIndexOf("#333333"));
	});

	test("the midpoint stays off both ends so a ramp still reads as three colours", () => {
		const flattened = animatedGradientCss(
			resolveAnimatedGradient({ config: { proportion: 0 } })
		);
		expect(flattened).toContain("15%");
		const pushed = animatedGradientCss(
			resolveAnimatedGradient({ config: { proportion: 100 } })
		);
		expect(pushed).toContain("85%");
	});

	test("rotation turns the ramp and stays inside one turn", () => {
		// 135 is the catalog's base angle for a two-stop ramp, so `rotation: 0`
		// matches the neighbouring banners rather than pointing somewhere new.
		expect(animatedGradientCss(resolveAnimatedGradient())).toContain("135deg");
		expect(
			animatedGradientCss(
				resolveAnimatedGradient({ config: { rotation: 300 } })
			)
		).toContain("75deg");
	});

	test("every preset paints something on a card without a live context", () => {
		for (const name of ANIMATED_GRADIENT_PRESET_NAMES) {
			const css = animatedGradientCss(
				resolveAnimatedGradient({ preset: name })
			);
			expect(css).toContain("linear-gradient(");
			expect(css).toContain("radial-gradient(");
			expect(css).not.toContain("undefined");
			expect(css).not.toContain("NaN");
		}
	});
});
