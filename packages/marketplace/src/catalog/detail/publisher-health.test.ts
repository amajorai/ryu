import { describe, expect, test } from "bun:test";
import { calculatePublisherHealth } from "./publisher-health.ts";

describe("calculatePublisherHealth", () => {
	test("keeps an unverified unsigned listing visibly risky", () => {
		const health = calculatePublisherHealth({
			publisherTrust: "dotted",
			reviewed: false,
			signatureStatus: "unsigned",
		});
		expect(health.score).toBeLessThan(40);
		expect(health.signals).toContainEqual({
			id: "identity",
			status: "warning",
			value: { id: "not-verified" },
		});
	});

	test("rewards independent evidence without implying endorsement", () => {
		const health = calculatePublisherHealth({
			publisherTrust: "blue",
			reviewed: true,
			signatureStatus: "verified",
			packageChecksum: "sha256:abc",
		});
		expect(health.score).toBeGreaterThan(70);
		expect(
			health.signals.some((signal) => signal.value.id === "identity-verified")
		).toBe(true);
	});

	test("returns raw counts and the rating average, never prebuilt English", () => {
		const health = calculatePublisherHealth({
			capabilities: ["net", "fs", "tools"],
			publisherTrust: "dotted",
			ratingAverage: 4.25,
			ratingCount: 1200,
		});
		expect(health.signals).toContainEqual({
			id: "capabilities",
			status: "neutral",
			value: { count: 3, id: "capabilities" },
		});
		expect(health.signals).toContainEqual({
			id: "ratings",
			status: "good",
			value: { average: 4.25, count: 1200, id: "rating" },
		});
	});
});
