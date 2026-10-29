import { describe, expect, test } from "bun:test";
import { Webhook } from "standardwebhooks";
import {
	PolarWebhookVerificationError,
	UnifiedPolarWebhookVerificationError,
	validatePolarEvent,
} from "./newpolar-webhooks.ts";

const legacySecret = "legacy-polar-secret";
const modernSecret = `whsec_${Buffer.from(
	Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 3) % 256)
).toString("base64")}`;

function eventBody(): string {
	const timestamp = new Date().toISOString();
	return JSON.stringify({
		type: "customer_seat.assigned",
		timestamp,
		data: {
			created_at: timestamp,
			modified_at: timestamp,
			id: "seat-test",
			status: "pending",
			customer_id: "customer-test",
		},
	});
}

function signedHeaders(secret: string, body: string, timestamp = new Date()) {
	const standardSecret = secret.startsWith("whsec_")
		? secret
		: Buffer.from(secret, "utf8").toString("base64");
	const webhook = new Webhook(standardSecret);
	return {
		"webhook-id": "msg-test",
		"webhook-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
		"webhook-signature": webhook.sign("msg-test", timestamp, body),
	};
}

describe("Polar webhook verification", () => {
	test("verifies whsec_ keys and parses the current SDK event schema", () => {
		const body = eventBody();
		const parsed = validatePolarEvent(
			body,
			signedHeaders(modernSecret, body),
			modernSecret
		);
		if (parsed.type !== "customer_seat.assigned") {
			throw new Error("Expected assigned seat event");
		}

		expect(parsed.type).toBe("customer_seat.assigned");
		expect(parsed.data.customerId).toBe("customer-test");
	});

	test("rejects a whsec_ delivery signed by a different key", () => {
		const body = eventBody();
		const wrongSecret = `whsec_${Buffer.from(
			Uint8Array.from({ length: 32 }, (_, index) => (index * 19 + 7) % 256)
		).toString("base64")}`;

		expect(() =>
			validatePolarEvent(body, signedHeaders(modernSecret, body), wrongSecret)
		).toThrow(UnifiedPolarWebhookVerificationError);
	});

	test("rejects a tampered body", () => {
		const body = eventBody();

		expect(() =>
			validatePolarEvent(
				`${body} `,
				signedHeaders(modernSecret, body),
				modernSecret
			)
		).toThrow(PolarWebhookVerificationError);
	});

	test("rejects a stale whsec_ delivery", () => {
		const body = eventBody();
		const stale = new Date(Date.now() - 10 * 60 * 1000);

		expect(() =>
			validatePolarEvent(
				body,
				signedHeaders(modernSecret, body, stale),
				modernSecret
			)
		).toThrow(UnifiedPolarWebhookVerificationError);
	});

	test("keeps the legacy raw-secret SDK verification path", () => {
		const body = eventBody();
		const parsed = validatePolarEvent(
			body,
			signedHeaders(legacySecret, body),
			legacySecret
		);
		if (parsed.type !== "customer_seat.assigned") {
			throw new Error("Expected assigned seat event");
		}

		expect(parsed.type).toBe("customer_seat.assigned");
		expect(parsed.data.customerId).toBe("customer-test");
	});
});
