import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ProofJsonRecord } from "./fixture-json.ts";

interface CapturedRequest {
	body?: unknown;
	headers: Record<string, string>;
	method: string;
	url: string;
}

interface BillingSnapshot {
	alert: {
		belowSince: string | null;
		lastError: string | null;
		notifiedAt: string | null;
		recipients: "none" | "owners" | "owners_admins";
		thresholdCents: number;
	} | null;
	autoTopup: {
		amountCents: number;
		cooldownSec: number;
		enabled: boolean;
		monthlyCapCents: number;
		thresholdCents: number;
	};
	externalUrls: string[];
	invoices: { id: string; amount: number; status: string }[];
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	scenario: "paid" | "trial";
	tauriCalls: { args: ProofJsonRecord | null; command: string }[];
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const EVIDENCE_DIR =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);

function evidencePath(name: string): string {
	return path.join(EVIDENCE_DIR, `${name}.png`);
}

async function readProof(page: Page): Promise<BillingSnapshot> {
	// The page's window type comes from the harness that installs it.
	return page.evaluate(() => window.__billingTabProof.snapshot());
}

async function configureFailures(
	page: Page,
	failures: Partial<Record<"alert" | "autotopup" | "budget" | "portal", number>>
): Promise<void> {
	await page.evaluate((next) => {
		window.__billingTabProof.configureFailures(next);
	}, failures);
}

function apiWrites(snapshot: BillingSnapshot, url: string): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) => request.url === url && request.method === "PUT"
	);
}

async function openBilling(
	page: Page,
	scenario: "paid" | "trial"
): Promise<void> {
	// BetterAuth captures fetch during its static module initialization, before
	// the harness installs its in-page API ledger. Serve this authentic client
	// request at the browser transport boundary instead.
	const sessionRequests: string[] = [];
	await page.route(
		(url) =>
			url.origin === "http://localhost:3000" &&
			url.pathname === "/api/auth/get-session",
		async (route) => {
			const request = route.request();
			expect(request.method()).toBe("GET");
			expect(request.headers().authorization).toBe(
				"Bearer billing-tab-proof-token"
			);
			sessionRequests.push(request.url());
			const now = new Date().toISOString();
			await route.fulfill({
				json: {
					session: {
						activeOrganizationId: "org-billing-fixture",
						createdAt: now,
						expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
						id: "session-billing-fixture",
						updatedAt: now,
						userId: "billing-tab-proof-user",
					},
					user: {
						createdAt: now,
						email: "billing@example.test",
						emailVerified: true,
						id: "billing-tab-proof-user",
						image: null,
						name: "Billing fixture",
						updatedAt: now,
					},
				},
				status: 200,
			});
		}
	);
	await page.route("**/api/step-up/**", async (route) =>
		route.fulfill({
			json: {
				action: "Open the billing portal",
				enrolmentRequired: false,
				methods: ["totp"],
				satisfied: true,
				scope: "billing",
				twoFactorEnabled: true,
				windowMs: 300_000,
			},
			status: 200,
		})
	);
	await page.goto(`/billing-tab-proof.html?scenario=${scenario}`);
	const nav = page.getByRole("button", { exact: true, name: "Billing" });
	await expect(nav).toBeVisible();
	await nav.click();
	await expect(
		page.getByRole("heading", { name: "Current plan" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Invoice history" })
	).toBeVisible();
	await expect.poll(() => sessionRequests.length).toBeGreaterThan(0);
}

async function selectOption(
	page: Page,
	label: string,
	option: string
): Promise<void> {
	await page.getByRole("combobox", { exact: true, name: label }).click();
	const item = page.getByRole("option", { exact: true, name: option });
	await expect(item).toBeVisible();
	await item.click();
}

async function blurWithTab(locator: Locator): Promise<void> {
	await locator.press("Tab");
}

test.describe.configure({ timeout: 90_000 });

test("validates and retries low-balance alerts, auto-recharge, and the sandbox budget", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openBilling(page, "trial");
	await expect(page.getByText("$42.50", { exact: true })).toBeVisible();

	const recipient = page.getByRole("combobox", { exact: true, name: "Email" });
	const thresholds = page.getByRole("spinbutton", {
		exact: true,
		name: "When balance falls below",
	});
	const autoThreshold = thresholds.nth(0);
	const alertThreshold = thresholds.nth(1);
	const amount = page.getByRole("spinbutton", {
		exact: true,
		name: "Automatically add",
	});
	const cap = page.getByRole("spinbutton", {
		exact: true,
		name: "Monthly recharge limit",
	});
	const recharge = page.getByRole("switch", {
		exact: true,
		name: "Automatic recharge",
	});
	await expect(recharge).toBeEnabled();
	await expect(recharge).not.toBeChecked();
	await expect(recipient).toContainText("No one (off)");
	await expect(alertThreshold).toBeDisabled();

	await configureFailures(page, { alert: 1 });
	await selectOption(page, "Email", "Owners only");
	await expect(recipient).toContainText("No one (off)");
	await expect(
		page.getByText("billing_fixture_temporarily_unavailable", { exact: true })
	).toBeVisible();
	await expect(apiWrites(await readProof(page), "/api/credits/alert")).toEqual([
		{
			body: { recipients: "owners", thresholdCents: 500 },
			headers: expect.anything(),
			method: "PUT",
			url: "/api/credits/alert",
		},
	]);

	await selectOption(page, "Email", "Owners only");
	await expect(recipient).toContainText("Owners only");
	await expect(alertThreshold).toBeEnabled();
	await alertThreshold.fill("0");
	await blurWithTab(alertThreshold);
	await expect(
		page.getByText("Set a balance threshold above $0.")
	).toBeVisible();
	await expect(
		apiWrites(await readProof(page), "/api/credits/alert")
	).toHaveLength(2);

	await alertThreshold.fill("12.50");
	await configureFailures(page, { alert: 1 });
	await blurWithTab(alertThreshold);
	await expect(
		page.getByText("billing_fixture_temporarily_unavailable", { exact: true })
	).toBeVisible();
	await expect(alertThreshold).toHaveValue("12.50");
	await expect(
		apiWrites(await readProof(page), "/api/credits/alert")
	).toHaveLength(3);
	await alertThreshold.click();
	await page.getByRole("heading", { name: "Sandbox spending" }).click();
	await expect
		.poll(
			async () => apiWrites(await readProof(page), "/api/credits/alert").length
		)
		.toBe(4);
	await expect
		.poll(async () => (await readProof(page)).alert?.thresholdCents)
		.toBe(1250);

	await amount.fill("4");
	await autoThreshold.fill("0");
	await cap.fill("100");
	await recharge.click();
	await expect(recharge).not.toBeChecked();
	await expect(
		page.getByText("Recharge amount must be between $5 and $1000.")
	).toBeVisible();
	await expect(
		apiWrites(await readProof(page), "/api/credits/autotopup")
	).toEqual([]);

	await amount.fill("25");
	await recharge.click();
	await expect(recharge).not.toBeChecked();
	await expect(
		page.getByText("Set a balance threshold above $0.")
	).toBeVisible();
	await expect(
		apiWrites(await readProof(page), "/api/credits/autotopup")
	).toEqual([]);

	await autoThreshold.fill("12.5");
	await amount.fill("25");
	await cap.fill("100");
	await configureFailures(page, { autotopup: 1 });
	await recharge.click();
	await expect(recharge).not.toBeChecked();
	await expect(
		page.getByText("billing_fixture_temporarily_unavailable", { exact: true })
	).toBeVisible();
	const failedTopupWrites = apiWrites(
		await readProof(page),
		"/api/credits/autotopup"
	);
	expect(failedTopupWrites).toHaveLength(1);
	expect(failedTopupWrites.map((request) => request.body)).toEqual([
		{
			amountCents: 2500,
			cooldownSec: 60,
			enabled: true,
			monthlyCapCents: 10_000,
			thresholdCents: 1250,
		},
	]);
	await recharge.click();
	await expect(recharge).toBeChecked();
	await expect
		.poll(
			async () =>
				apiWrites(await readProof(page), "/api/credits/autotopup").length
		)
		.toBe(2);
	await expect
		.poll(async () => (await readProof(page)).autoTopup.enabled)
		.toBe(true);

	await autoThreshold.fill("15");
	await blurWithTab(autoThreshold);
	await amount.fill("30");
	await blurWithTab(amount);
	await cap.fill("200");
	await blurWithTab(cap);
	await expect
		.poll(async () => {
			const state = (await readProof(page)).autoTopup;
			return [state.thresholdCents, state.amountCents, state.monthlyCapCents];
		})
		.toEqual([1500, 3000, 20_000]);

	const budget = page.getByRole("spinbutton", {
		exact: true,
		name: "Default sandbox run budget",
	});
	await expect(budget).toHaveValue("15");
	await configureFailures(page, { budget: 1 });
	await budget.fill("12.34");
	await blurWithTab(budget);
	await expect(
		page.getByText("Couldn't save the sandbox run budget.", { exact: true })
	).toBeVisible();
	await budget.focus();
	await blurWithTab(budget);
	await expect
		.poll(
			async () =>
				(await readProof(page)).preferences[
					"sandbox-default-run-budget-micro-usd"
				]
		)
		.toBe("12340000");

	const finalState = await readProof(page);
	expect(
		apiWrites(finalState, "/api/credits/alert").map((request) => request.body)
	).toEqual([
		{ recipients: "owners", thresholdCents: 500 },
		{ recipients: "owners", thresholdCents: 500 },
		{ recipients: "owners", thresholdCents: 1250 },
		{ recipients: "owners", thresholdCents: 1250 },
	]);
	expect(
		apiWrites(finalState, "/api/credits/autotopup").map(
			(request) => request.body
		)
	).toEqual([
		{
			amountCents: 2500,
			cooldownSec: 60,
			enabled: true,
			monthlyCapCents: 10_000,
			thresholdCents: 1250,
		},
		{
			amountCents: 2500,
			cooldownSec: 60,
			enabled: true,
			monthlyCapCents: 10_000,
			thresholdCents: 1250,
		},
		{
			amountCents: 2500,
			cooldownSec: 60,
			enabled: true,
			monthlyCapCents: 10_000,
			thresholdCents: 1500,
		},
		{
			amountCents: 3000,
			cooldownSec: 60,
			enabled: true,
			monthlyCapCents: 10_000,
			thresholdCents: 1500,
		},
		{
			amountCents: 3000,
			cooldownSec: 60,
			enabled: true,
			monthlyCapCents: 20_000,
			thresholdCents: 1500,
		},
	]);
	expect(
		apiWrites(
			finalState,
			"/api/preferences/sandbox-default-run-budget-micro-usd"
		).map(({ body, method, url }) => ({ body, method, url }))
	).toEqual([
		{
			body: { value: "12340000" },
			method: "PUT",
			url: "/api/preferences/sandbox-default-run-budget-micro-usd",
		},
		{
			body: { value: "12340000" },
			method: "PUT",
			url: "/api/preferences/sandbox-default-run-budget-micro-usd",
		},
	]);
	expect(pageErrors).toEqual([]);

	await page.reload();
	await page.getByRole("button", { exact: true, name: "Billing" }).click();
	await expect(
		page.getByRole("combobox", { exact: true, name: "Email" })
	).toContainText("Owners only");
	await expect(
		page
			.getByRole("spinbutton", {
				exact: true,
				name: "When balance falls below",
			})
			.nth(0)
	).toHaveValue("15");
	await expect(amount).toHaveValue("30");
	await expect(cap).toHaveValue("200");
	await expect(
		page.getByRole("switch", { exact: true, name: "Automatic recharge" })
	).toBeChecked();
	await expect(
		page.getByRole("spinbutton", {
			exact: true,
			name: "Default sandbox run budget",
		})
	).toHaveValue("12.34");
	await page
		.getByRole("switch", { exact: true, name: "Automatic recharge" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("billing-tab-autotopup-persisted"),
	});
	await page
		.getByRole("spinbutton", {
			exact: true,
			name: "Default sandbox run budget",
		})
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("billing-tab-topup-alert-budget-persisted"),
	});
});

test("renders plan and invoice history and retries portal and lifetime actions", async ({
	page,
}) => {
	await openBilling(page, "paid");
	await expect(
		page.getByText("Monthly subscription", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { exact: true, name: "Manage subscription" })
	).toBeVisible();
	await expect(page.getByText("$19.99", { exact: true })).toBeVisible();
	await expect(page.getByText("$5.00", { exact: true })).toBeVisible();
	await expect(page.getByText("paid", { exact: true })).toBeVisible();
	await expect(page.getByText("open", { exact: true })).toBeVisible();

	await configureFailures(page, { portal: 1 });
	await page
		.getByRole("button", { exact: true, name: "Manage subscription" })
		.click();
	await expect(
		page.getByText("Failed to open subscription portal. Please try again.", {
			exact: true,
		})
	).toBeVisible();
	await expect((await readProof(page)).externalUrls).toEqual([]);
	await page
		.getByRole("button", { exact: true, name: "Manage subscription" })
		.click();
	await expect
		.poll(async () => (await readProof(page)).externalUrls)
		.toEqual(["https://billing.fixture.test/portal/1"]);

	const managePayment = page.getByRole("button", {
		exact: true,
		name: "Manage",
	});
	await configureFailures(page, { portal: 1 });
	await managePayment.click();
	await expect(
		page.getByText("Couldn't open the billing portal. Please try again.", {
			exact: true,
		})
	).toBeVisible();
	await managePayment.click();
	await expect
		.poll(async () => (await readProof(page)).externalUrls)
		.toEqual([
			"https://billing.fixture.test/portal/1",
			"https://billing.fixture.test/portal/2",
		]);

	await page
		.getByRole("button", { exact: true, name: "Get lifetime access" })
		.click();
	await expect
		.poll(async () => (await readProof(page)).externalUrls)
		.toEqual([
			"https://billing.fixture.test/portal/1",
			"https://billing.fixture.test/portal/2",
			"https://checkout.fixture.test/lifetime",
		]);

	const state = await readProof(page);
	const portalRequests = state.requests.filter(
		(request) =>
			request.url === "/api/billing/portal" && request.method === "GET"
	);
	expect(portalRequests).toHaveLength(4);
	const checkout = state.requests.find(
		(request) =>
			request.url === "/api/billing/checkout/lifetime" &&
			request.method === "POST"
	);
	expect(checkout?.body).toEqual({});
	expect(checkout?.headers["idempotency-key"]).toMatch(/.+/u);
	expect(
		state.tauriCalls
			.filter((call) => call.command === "open_external")
			.map((call) => call.args)
	).toEqual([
		{ url: "https://billing.fixture.test/portal/1" },
		{ url: "https://billing.fixture.test/portal/2" },
		{ url: "https://checkout.fixture.test/lifetime" },
	]);

	await page.reload();
	await page.getByRole("button", { exact: true, name: "Billing" }).click();
	await expect(
		page.getByRole("button", { exact: true, name: "Manage subscription" })
	).toBeVisible();
	await expect(page.getByText("$19.99", { exact: true })).toBeVisible();
	await expect(page.getByText("$5.00", { exact: true })).toBeVisible();
	await page
		.getByRole("heading", { name: "Invoice history" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("billing-tab-plan-invoices-portal"),
	});
});

test("Unlock Pro opens the actual trial-expired paywall", async ({ page }) => {
	await openBilling(page, "trial");
	const unlock = page.getByRole("button", { exact: true, name: "Unlock Pro" });
	await expect(unlock).toBeVisible();
	await unlock.click();
	await expect(
		page.getByRole("heading", { name: /trial has ended/iu })
	).toBeVisible();
	await expect(
		page.getByRole("button", { exact: true, name: "Continue with free chat" })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("billing-tab-desktop-trial-paywall"),
	});
});
