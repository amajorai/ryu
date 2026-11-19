import { describe, expect, test } from "bun:test";
import { hostFailureReason, hostFailureStatus } from "./host-failure.ts";

function relayed(fields: Record<string, unknown>): Error {
	return Object.assign(
		new Error("/api/ext/@ryu/places/trips failed: 409"),
		fields
	);
}

describe("hostFailureReason", () => {
	test("returns the server sentence the host relayed", () => {
		expect(
			hostFailureReason(
				relayed({ reason: " This trip changed since you opened it. " })
			)
		).toBe("This trip changed since you opened it.");
	});

	test("strips control and bidi characters", () => {
		expect(
			hostFailureReason(
				relayed({
					reason: `Trip${String.fromCodePoint(0x20_2e)} name\u0007 taken.`,
				})
			)
		).toBe("Trip name taken.");
	});

	test("ignores a missing, empty, non-string or oversized reason", () => {
		expect(hostFailureReason(relayed({}))).toBeNull();
		expect(hostFailureReason(relayed({ reason: "  " }))).toBeNull();
		expect(hostFailureReason(relayed({ reason: 42 }))).toBeNull();
		expect(hostFailureReason(relayed({ reason: "x".repeat(501) }))).toBeNull();
		expect(hostFailureReason("boom")).toBeNull();
		expect(hostFailureReason(null)).toBeNull();
	});
});

describe("hostFailureStatus", () => {
	test("prefers the relayed status", () => {
		expect(hostFailureStatus(relayed({ status: 422 }))).toBe(422);
	});

	test("falls back to the transport message of an older host", () => {
		expect(hostFailureStatus(relayed({}))).toBe(409);
		expect(hostFailureStatus(new Error("socket hang up"))).toBeNull();
		expect(hostFailureStatus(relayed({ status: 200 }))).toBe(409);
	});
});
