import { expect, test } from "bun:test";
import {
	act,
	authClient,
	button,
	calls,
	click,
	enterCode,
	GOOD_CODE,
	harness,
	maybeButton,
	mount,
	runtimeErrors,
	settle,
	tauri,
	text,
	until,
} from "./BillingTab.native-http.harness.ts";

// Lifetime access on the shipping Billing tab, and the tab surviving a
// degraded session reply. Lifetime is an individual plan, so it follows the
// `billing.individual_plans` rollout flag the server publishes.

test("Lifetime: Get lifetime access opens the checkout the server issues after the billing code, with a fresh idempotency key", async () => {
	await mount();
	await until(
		() => Boolean(maybeButton("Get lifetime access")),
		"lifetime row missing"
	);
	expect(text()).toContain(
		"Pay once, own it forever. Includes 1 year of updates."
	);
	await click(button("Get lifetime access"));
	await enterCode(GOOD_CODE);
	await until(
		() => tauri.some((call) => call.command === "open_external"),
		"checkout never opened"
	);
	expect(
		tauri
			.filter((call) => call.command === "open_external")
			.map((call) => call.args)
	).toEqual([{ url: "https://checkout.example.test/lifetime/org-north" }]);
	const checkout = calls.filter(
		(call) => call.path === "/api/billing/checkout/lifetime"
	);
	expect(checkout.map((call) => [call.body, call.status])).toEqual([[{}, 200]]);
	expect(checkout[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
});

test("Lifetime: with billing.individual_plans off the tab offers no lifetime purchase and never calls its checkout", async () => {
	harness.features = { "billing.individual_plans": false };
	await mount();
	await until(
		() => text().includes("Automatic recharge"),
		"billing tab never rendered"
	);
	await until(
		() =>
			calls.some((call) => call.path === "/api/billing/subscription-status"),
		"flags never fetched"
	);
	await settle(40);
	expect(maybeButton("Get lifetime access")).toBeFalsy();
	expect(text()).not.toContain("Lifetime access");
	expect(text()).not.toContain(
		"Pay once, own it forever. Includes 1 year of updates."
	);
	expect(
		calls.some((call) => call.path === "/api/billing/checkout/lifetime")
	).toBe(false);
});

test("A session reply that carries no user keeps the tab rendering instead of throwing on the account id", async () => {
	await mount();
	await until(
		() => Boolean(maybeButton("Get lifetime access")),
		"signed-in tab missing"
	);
	// The auth client keeps its last answer between cases, so make it ask again
	// and answer with a body that has no user.
	harness.sessionReply = [];
	try {
		await act(async () => authClient.$store.notify("$sessionSignal"));
		await settle(40);
		// The crash unmounted the whole tree, so a surviving tab is the assertion.
		expect(text()).toContain("Automatic recharge");
		expect(runtimeErrors).toEqual([]);
	} finally {
		harness.sessionReply = undefined;
		await act(async () => authClient.$store.notify("$sessionSignal"));
	}
});
