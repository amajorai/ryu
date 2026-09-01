import { describe, expect, test } from "bun:test";
import {
	connectionAccessLabel,
	connectionAccessOption,
	DEFAULT_CONNECTION_ACCESS_LEVEL,
	normalizeConnectionAccessLevel,
} from "./connection-permissions.ts";

describe("connection access policy", () => {
	test("defaults unknown or missing wire values to risk-based", () => {
		expect(DEFAULT_CONNECTION_ACCESS_LEVEL).toBe("risk_based");
		expect(normalizeConnectionAccessLevel(undefined)).toBe("risk_based");
		expect(normalizeConnectionAccessLevel("future_level")).toBe("risk_based");
		expect(connectionAccessLabel(undefined)).toBe("Risk-based");
	});

	test("explains the four ceilings in the same order as the dialog", () => {
		expect(connectionAccessOption("risk_based")).toMatchObject({
			label: "Risk-based (recommended)",
			shortLabel: "Risk-based",
		});
		expect(connectionAccessOption("read_only").description).toContain(
			"No creating, changing, sending, or deleting"
		);
		expect(connectionAccessOption("write").description).toContain(
			"Delete actions stay blocked"
		);
		expect(connectionAccessOption("full").label).toContain("including delete");
	});
});
