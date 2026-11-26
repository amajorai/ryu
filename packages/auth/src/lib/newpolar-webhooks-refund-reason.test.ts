import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Webhook } from "standardwebhooks";
import {
	PolarWebhookVerificationError,
	validatePolarEvent,
} from "./newpolar-webhooks.ts";

// PW-24, part 1. The installed Polar SDK refuses a refund whose reason is not
// one of the seven it lists, so a correctly signed refund event with a newer
// reason failed as a whole. Both secret formats are covered, because each one
// reaches the SDK's refund schema by its own path.
const secrets = [
	[
		"whsec_ secret",
		`whsec_${Buffer.from(
			Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 3) % 256)
		).toString("base64")}`,
	],
	["legacy secret", "legacy-polar-secret"],
] as const;
const otherSecrets = {
	"whsec_ secret": `whsec_${Buffer.from(
		Uint8Array.from({ length: 32 }, (_, index) => (index * 19 + 7) % 256)
	).toString("base64")}`,
	"legacy secret": "another-legacy-polar-secret",
} as const;

const refundTypes = ["refund.created", "refund.updated"] as const;
const unlistedReasons = [
	"tax_refund",
	"vat_reverse_charge_correction",
	"made_up_reason_x",
] as const;
const listedReasons = [
	"duplicate",
	"fraudulent",
	"customer_request",
	"service_disruption",
	"satisfaction_guarantee",
	"dispute_prevention",
	"other",
] as const;

const sentAt = "2026-11-22T04:00:00.000Z";

function refundBody(
	type: string,
	reason: unknown,
	data: Record<string, unknown> = {}
): string {
	return JSON.stringify({
		type,
		timestamp: sentAt,
		data: {
			created_at: sentAt,
			modified_at: null,
			id: "refund-test",
			metadata: {},
			status: "succeeded",
			reason,
			amount: 2000,
			tax_amount: 380,
			currency: "usd",
			organization_id: "polar-organization-test",
			order_id: "order-test",
			subscription_id: "subscription-test",
			customer_id: "customer-test",
			revoke_benefits: false,
			dispute: null,
			...data,
		},
	});
}

function signedHeaders(secret: string, body: string, timestamp = new Date()) {
	const standardSecret = secret.startsWith("whsec_")
		? secret
		: Buffer.from(secret, "utf8").toString("base64");
	return {
		"webhook-id": "msg-test",
		"webhook-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
		"webhook-signature": new Webhook(standardSecret).sign(
			"msg-test",
			timestamp,
			body
		),
	};
}

function parseRefund(secret: string, body: string) {
	const parsed = validatePolarEvent(body, signedHeaders(secret, body), secret);
	if (parsed.type !== "refund.created" && parsed.type !== "refund.updated") {
		throw new Error("Expected a refund event");
	}
	return parsed;
}

/** The error a call throws, or null. */
function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return null;
}

function quietWarnings() {
	return spyOn(console, "warn").mockImplementation(() => undefined);
}

afterEach(() => {
	mock.restore();
});

for (const [kind, secret] of secrets) {
	describe(`a signed Polar refund with a reason the SDK does not list, ${kind}`, () => {
		for (const type of refundTypes) {
			for (const reason of unlistedReasons) {
				test(`accepts ${type} with the reason ${reason} and reads it as other`, () => {
					const warn = quietWarnings();
					const known = parseRefund(secret, refundBody(type, "other"));
					expect(warn).not.toHaveBeenCalled();

					const parsed = parseRefund(secret, refundBody(type, reason));

					// Exactly the event a refund with the listed reason "other" gives,
					// so the billing handler cannot tell the two apart.
					expect(parsed).toEqual(known);
					expect(parsed.type).toBe(type);
					expect(parsed.data.reason).toBe("other");
					expect(parsed.data.id).toBe("refund-test");
					expect(parsed.data.orderId).toBe("order-test");
					expect(parsed.data.subscriptionId).toBe("subscription-test");
					expect(parsed.data.amount).toBe(2000);
					expect(parsed.data.taxAmount).toBe(380);
					expect(warn.mock.calls).toEqual([
						[
							"[polar-webhook] unknown refund reason read as other:",
							{ type, refundId: "refund-test", rawReason: reason },
						],
					]);
				});
			}
		}
	});

	describe(`guards for a Polar refund with a reason the SDK does not list, ${kind}`, () => {
		for (const reason of unlistedReasons) {
			test(`refuses refund.created with the reason ${reason} signed by another key`, () => {
				const warn = quietWarnings();
				const body = refundBody("refund.created", reason);

				expect(() =>
					validatePolarEvent(
						body,
						signedHeaders(otherSecrets[kind], body),
						secret
					)
				).toThrow(PolarWebhookVerificationError);
				expect(warn).not.toHaveBeenCalled();
			});
		}

		test("refuses a body changed after signing to carry an unlisted reason", () => {
			const warn = quietWarnings();
			const signed = refundBody("refund.created", "customer_request");
			const changed = refundBody("refund.created", "tax_refund");

			expect(() =>
				validatePolarEvent(changed, signedHeaders(secret, signed), secret)
			).toThrow(PolarWebhookVerificationError);
			expect(warn).not.toHaveBeenCalled();
		});

		test("refuses a stale delivery that carries an unlisted reason", () => {
			const warn = quietWarnings();
			const body = refundBody("refund.updated", "tax_refund");
			const stale = new Date(Date.now() - 10 * 60 * 1000);

			expect(() =>
				validatePolarEvent(body, signedHeaders(secret, body, stale), secret)
			).toThrow(PolarWebhookVerificationError);
			expect(warn).not.toHaveBeenCalled();
		});

		test("refuses a delivery with no signature header that carries an unlisted reason", () => {
			const warn = quietWarnings();
			const body = refundBody("refund.created", "tax_refund");
			const { "webhook-signature": _signature, ...unsigned } = signedHeaders(
				secret,
				body
			);

			expect(() => validatePolarEvent(body, unsigned, secret)).toThrow(
				PolarWebhookVerificationError
			);
			expect(warn).not.toHaveBeenCalled();
		});

		test("keeps every reason the SDK lists as it is and logs nothing", () => {
			const warn = quietWarnings();

			for (const type of refundTypes) {
				for (const reason of listedReasons) {
					const parsed = parseRefund(secret, refundBody(type, reason));
					expect(parsed.type).toBe(type);
					expect(parsed.data.reason).toBe(reason);
					expect(parsed.data.orderId).toBe("order-test");
				}
			}
			expect(warn).not.toHaveBeenCalled();
		});

		test("still refuses an unlisted reason when another field of the refund is broken", () => {
			quietWarnings();
			const body = refundBody("refund.created", "tax_refund", {
				order_id: undefined,
			});

			const error = thrownBy(() =>
				validatePolarEvent(body, signedHeaders(secret, body), secret)
			);

			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(PolarWebhookVerificationError);
		});

		test("still refuses a refund whose reason is missing or not text", () => {
			const warn = quietWarnings();

			for (const reason of [undefined, null, 7, ["tax_refund"]]) {
				const body = refundBody("refund.created", reason);
				const error = thrownBy(() =>
					validatePolarEvent(body, signedHeaders(secret, body), secret)
				);
				expect(error).toBeInstanceOf(Error);
				expect(error).not.toBeInstanceOf(PolarWebhookVerificationError);
			}
			expect(warn).not.toHaveBeenCalled();
		});

		test("still refuses a refund whose status the SDK does not list", () => {
			const warn = quietWarnings();
			const body = refundBody("refund.created", "customer_request", {
				status: "made_up_status_x",
			});

			const error = thrownBy(() =>
				validatePolarEvent(body, signedHeaders(secret, body), secret)
			);

			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(PolarWebhookVerificationError);
			expect(warn).not.toHaveBeenCalled();
		});

		test("does not read a reason field of another event type", () => {
			const warn = quietWarnings();
			const body = JSON.stringify({
				type: "customer_seat.assigned",
				timestamp: sentAt,
				data: {
					created_at: sentAt,
					modified_at: sentAt,
					id: "seat-test",
					status: "made_up_status_x",
					customer_id: "customer-test",
					reason: "tax_refund",
				},
			});

			const error = thrownBy(() =>
				validatePolarEvent(body, signedHeaders(secret, body), secret)
			);

			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(PolarWebhookVerificationError);
			expect(warn).not.toHaveBeenCalled();
		});

		test("leaves a signed event of an unknown type as it was", () => {
			const warn = quietWarnings();
			const body = JSON.stringify({
				type: "made_up.event",
				timestamp: sentAt,
				data: { id: "refund-test", reason: "tax_refund" },
			});

			const error = thrownBy(() =>
				validatePolarEvent(body, signedHeaders(secret, body), secret)
			);

			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(PolarWebhookVerificationError);
			expect(warn).not.toHaveBeenCalled();
		});
	});
}

test("the legacy path keeps the SDK's own error when the refund is broken in another field", () => {
	quietWarnings();
	const secret = "legacy-polar-secret";
	const body = refundBody("refund.created", "tax_refund", {
		order_id: undefined,
	});

	const error = thrownBy(() =>
		validatePolarEvent(body, signedHeaders(secret, body), secret)
	);

	expect(error).toBeInstanceOf(Error);
	expect(error instanceof Error ? error.message : "").toStartWith(
		"Failed to parse event"
	);
});
