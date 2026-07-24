import { describe, expect, it } from "bun:test";
import { DEFAULT_EDGE_OFFSET } from "../shared/edge-offset.ts";
import { getEdgeOffset, setEdgeOffset } from "./edge-offset.ts";

// The in-process holder positioning code reads live, so a settings change takes
// effect without re-registering IPC. This pins the seed + live-update contract.
describe("edge-offset holder", () => {
	it("starts seeded at the platform default", () => {
		expect(getEdgeOffset()).toBe(DEFAULT_EDGE_OFFSET);
	});

	it("reflects the last set value on the next read", () => {
		setEdgeOffset(42);
		expect(getEdgeOffset()).toBe(42);
		setEdgeOffset(0);
		expect(getEdgeOffset()).toBe(0);
		// Restore so the default-seed assertion order does not matter across files.
		setEdgeOffset(DEFAULT_EDGE_OFFSET);
		expect(getEdgeOffset()).toBe(DEFAULT_EDGE_OFFSET);
	});
});
