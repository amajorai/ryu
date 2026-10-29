import { describe, expect, test } from "bun:test";
import { supportsBuiltInAcrylic } from "./windows-material.ts";

describe("Windows Acrylic support", () => {
	test("uses a native fallback on Windows 10 and Windows 11 21H2", () => {
		expect(supportsBuiltInAcrylic("10.0.19045")).toBe(false);
		expect(supportsBuiltInAcrylic("10.0.22000")).toBe(false);
	});

	test("keeps Electron's built-in Acrylic on Windows 11 22H2 and later", () => {
		expect(supportsBuiltInAcrylic("10.0.22621")).toBe(true);
		expect(supportsBuiltInAcrylic("10.0.26100")).toBe(true);
	});

	test("treats an unknown build as unsupported", () => {
		expect(supportsBuiltInAcrylic("")).toBe(false);
		expect(supportsBuiltInAcrylic("unknown")).toBe(false);
	});
});
