import { expect, test } from "bun:test";
import { openSse } from "@ryuhq/protocol/sse";
import type { z } from "zod";
import {
	billingStatusUpdateSchema,
	piLoginEventSchema,
} from "./billing-login-stream-contracts.ts";
import {
	creditAlertEventSchema,
	walletUpdateSchema,
} from "./credits-wire-contracts.ts";

const subscription = {
	entitlement: {
		desktopAccess: true,
		managedInference: false,
		marketplaceApps: true,
		monthlyCreditPoolMicroUsd: 100,
		plan: "future-plan",
		seats: 1,
	},
	features: { future: true },
	giftSubscription: null,
	hostedAgents: null,
	lifetime: { expired: false, updatesExpiresAt: "later" },
	organizationId: null,
	plan: "future-plan",
	scope: "user",
	seats: 1,
	subscription: { future: [null, true] },
} satisfies z.output<typeof billingStatusUpdateSchema>["subscription"];
test("billing checks the full wire snapshot without projecting away server metadata", () => {
	const payload = {
		organizationId: null,
		scope: "user",
		seats: null,
		subscription,
		future: { revision: 4 },
	} satisfies z.output<typeof billingStatusUpdateSchema>;
	expect(billingStatusUpdateSchema.parse(payload)).toBe(payload);
	expect(
		billingStatusUpdateSchema.safeParse({
			...payload,
			subscription: {
				...subscription,
				entitlement: { ...subscription.entitlement, marketplaceApps: "yes" },
			},
		}).success
	).toBe(false);
	const invalidFlags = JSON.parse('{"__proto__":"enabled"}');
	expect(
		billingStatusUpdateSchema.safeParse({
			...payload,
			subscription: { ...subscription, features: invalidFlags },
		}).success
	).toBe(false);
	expect(
		billingStatusUpdateSchema.safeParse({
			...payload,
			subscription: { ...subscription, features: { future: "yes" } },
		}).success
	).toBe(false);
	expect(
		billingStatusUpdateSchema.safeParse({
			...payload,
			seats: { allocatedSeats: 1 },
		}).success
	).toBe(false);
});
test("login preserves future bridge events and checks nested prompts", () => {
	const prompt = {
		message: "Choose",
		type: "future-prompt",
		options: [{ id: "one", label: "One", future: true }],
	};
	const payload = {
		type: "future-event",
		prompt,
		provider: "future-provider",
		future: [1, null],
	};
	expect(piLoginEventSchema.parse(payload)).toBe(payload);
	expect(piLoginEventSchema.parse(payload).prompt).toBe(prompt);
	expect(
		piLoginEventSchema.safeParse({
			...payload,
			prompt: { ...prompt, options: [{ id: 4, label: "One" }] },
		}).success
	).toBe(false);
	expect(
		piLoginEventSchema.safeParse({ ...payload, planUseAuthorized: "true" })
			.success
	).toBe(false);
});
test("wallet and alert frames retain original JSON including prototype-named metadata", () => {
	const wallet = JSON.parse(
		'{"balanceMicroUsd":0,"currency":"future","id":"wallet","ownerId":"org","updatedAt":"now","__proto__":{"future":true}}'
	);
	expect(walletUpdateSchema.parse(wallet)).toBe(wallet);
	expect(
		walletUpdateSchema.safeParse({ ...wallet, balanceMicroUsd: "0" }).success
	).toBe(false);
	const alert = {
		balanceMicroUsd: 0,
		createdAt: "now",
		level: "warning",
		thresholdMicroUsd: 10,
		title: "Low",
		future: [1],
	} satisfies z.output<typeof creditAlertEventSchema>;
	expect(creditAlertEventSchema.parse(alert)).toBe(alert);
	expect(
		creditAlertEventSchema.safeParse({ ...alert, level: "critical" }).success
	).toBe(false);
	expect(
		creditAlertEventSchema.safeParse({ ...alert, thresholdMicroUsd: null })
			.success
	).toBe(false);
});
test("native SSE transport decodes frames before yielding and continues after an invalid payload", async () => {
	const authorizations: (string | null)[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			authorizations.push(request.headers.get("authorization"));
			return new Response(
				'event: login\ndata: {"type":4}\n\nevent: login\ndata: {"type":"future-event","message":"ready"}\n\n',
				{ headers: { "content-type": "text/event-stream" } }
			);
		},
	});
	try {
		const frames = await Array.fromAsync(
			openSse(server.url.href, {
				token: "session",
				decode: piLoginEventSchema.parse,
			})
		);
		expect(authorizations).toEqual(["Bearer session"]);
		expect(frames).toEqual([
			{ event: "login", data: { type: "future-event", message: "ready" } },
		]);
	} finally {
		server.stop(true);
	}
});
