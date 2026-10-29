import { describe, expect, it } from "bun:test";
import { isFullAccessEquivalent } from "./full-access-warning.tsx";

function item(id: string, name = id) {
	return { id, name };
}

describe("isFullAccessEquivalent", () => {
	it.each([
		["bypassPermissions", "Bypass permissions"],
		["danger-full-access", "Danger full access"],
		["full_access", "Full access"],
		["yolo", "YOLO"],
		["unrestricted", "Unrestricted"],
		["skip-permissions", "Skip permissions"],
		["always-allow", "Always allow"],
	])("recognizes %s as full-access-equivalent", (id, name) => {
		expect(isFullAccessEquivalent(item(id, name))).toBe(true);
	});

	it("recognizes a separate approval policy's never value", () => {
		expect(isFullAccessEquivalent(item("never"), "Approval policy")).toBe(true);
	});

	it("does not classify ordinary ACP modes", () => {
		const ordinaryModes: [string, string][] = [
			["plan", "Plan"],
			["acceptEdits", "Accept edits"],
			["auto", "Auto"],
			["read-only", "Read-only"],
			["never", "Never"],
		];
		for (const [id, name] of ordinaryModes) {
			expect(isFullAccessEquivalent(item(id, name), "Thinking")).toBe(false);
		}
	});
});
