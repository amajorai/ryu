import { describe, expect, test } from "bun:test";
import { appIconMaterialSvg, iconSeedHue } from "./app-icon-material.ts";

describe("app icon material", () => {
	test("is deterministic and uses stable package identity", () => {
		expect(iconSeedHue("@ryu/browser")).toBe(iconSeedHue("@ryu/browser"));
		expect(appIconMaterialSvg({ seed: "@ryu/browser" })).not.toBe(
			appIconMaterialSvg({ seed: "@ryu/mail" })
		);
	});
	test("untrusted palette tokens never enter vector markup", () => {
		for (const from of [
			"constructor",
			"__proto__",
			"<script>alert(1)</script>",
			Number.NaN,
			{},
			null,
		]) {
			expect(appIconMaterialSvg({ seed: "test", from })).toBe(
				appIconMaterialSvg({ seed: "test" })
			);
		}
	});
	test("normalizes hue rotations and keeps appearances distinct", () => {
		expect(appIconMaterialSvg({ seed: "test", from: -9 })).toBe(
			appIconMaterialSvg({ seed: "test", from: 351 })
		);
		const input = { seed: "test", from: 212 };
		expect(appIconMaterialSvg(input, "dark")).not.toBe(
			appIconMaterialSvg(input)
		);
		expect(appIconMaterialSvg(input, "mono")).not.toBe(
			appIconMaterialSvg(input)
		);
	});
});
