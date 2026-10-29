import { describe, expect, it } from "bun:test";
import { installerComponentLabel } from "./installer-progress.ts";

describe("installer progress labels", () => {
	it("uses the product names shared by onboarding and background toasts", () => {
		expect(installerComponentLabel("ryu-core")).toBe("Ryu Core");
		expect(installerComponentLabel("ryu-gateway")).toBe("the model gateway");
		expect(installerComponentLabel("bundled-defaults")).toBe(
			"bundled models, engines, and skills"
		);
		expect(installerComponentLabel("shadow")).toBe("Shadow");
		expect(installerComponentLabel("ghost")).toBe("Ghost");
		expect(installerComponentLabel("island")).toBe("Ryu Island");
	});

	it("keeps unknown installer components visible", () => {
		expect(installerComponentLabel("future-sidecar")).toBe("future-sidecar");
	});
	it("keeps inherited-name installer components as visible raw names", () => {
		for (const component of ["constructor", "toString", "__proto__"]) {
			expect(installerComponentLabel(component)).toBe(component);
		}
	});
});
