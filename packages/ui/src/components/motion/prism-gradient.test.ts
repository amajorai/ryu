import { expect, test } from "bun:test";
import { isSoftwareWebglRenderer } from "./prism-gradient.tsx";

test("software WebGL rasterizers are recognized so the prism renders a still frame", () => {
	for (const renderer of [
		"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
		"Google SwiftShader",
		"llvmpipe (LLVM 15.0.7, 256 bits)",
		"Mesa softpipe",
		"ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
	]) {
		expect(isSoftwareWebglRenderer(renderer)).toBe(true);
	}
});

test("hardware WebGL renderers keep the animated prism", () => {
	for (const renderer of [
		"ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
		"ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
		"Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
		"WebKit WebGL",
	]) {
		expect(isSoftwareWebglRenderer(renderer)).toBe(false);
	}
	expect(isSoftwareWebglRenderer(null)).toBe(false);
	expect(isSoftwareWebglRenderer(undefined)).toBe(false);
});
