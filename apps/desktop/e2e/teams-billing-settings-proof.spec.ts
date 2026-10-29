import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { InvokeArgs } from "@tauri-apps/api/core";

interface RequestRecord {
	body: unknown;
	headers: Record<string, string>;
	method: string;
	path: string;
}

interface TeamsBillingSnapshot {
	activeOrganizationId: string | null;
	billedSeats: number;
	externalUrls: string[];
	failures: {
		"GET /api/billing/seats"?: {
			message: string;
			remaining: number;
			status: number;
		};
	};
	organizationPlan: "business" | "teams" | "teams-lite" | null;
	requests: RequestRecord[];
	role: "admin" | "member" | "owner" | "viewer";
	tauriCalls: { args: InvokeArgs | null; command: string }[];
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceDir =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);

mkdirSync(evidenceDir, { recursive: true });

function evidencePath(name: string): string {
	return path.join(evidenceDir, name);
}

async function readProof(page: import("@playwright/test").Page) {
	return page.evaluate(() => window.__teamsBillingSettingsProof.snapshot());
}

async function armFailure(
	page: import("@playwright/test").Page,
	operation: string,
	status: number,
	message: string,
	needsUpgrade = false
): Promise<void> {
	await page.evaluate(
		({
			message: failureMessage,
			needsUpgrade: upgrade,
			operation: key,
			status: code,
		}) => {
			window.__teamsBillingSettingsProof.armFailure(
				key,
				code,
				failureMessage,
				upgrade
			);
		},
		{ message, needsUpgrade, operation, status }
	);
}

async function setServerRole(
	page: import("@playwright/test").Page,
	role: "admin" | "member" | "owner" | "viewer"
): Promise<void> {
	await page.evaluate((nextRole) => {
		window.__teamsBillingSettingsProof.setServerRole(nextRole);
	}, role);
}

async function openPlanSurface(
	page: import("@playwright/test").Page,
	query: string
): Promise<void> {
	await page.goto(`/teams-billing-settings-proof.html?${query}&reset=true`);
	await expect(page.getByText("Pooled wallet", { exact: true })).toBeVisible();
}

function requestsFor(
	snapshot: TeamsBillingSnapshot,
	method: string,
	path: string
): RequestRecord[] {
	return snapshot.requests.filter(
		(request) => request.method === method && request.path === path
	);
}

test.describe.configure({ timeout: 90_000 });

test("shows sign-in and no-organization states, then opens the organization picker", async ({
	page,
}) => {
	await page.goto(
		"/teams-billing-settings-proof.html?scenario=signed-out&reset=true"
	);
	await expect(
		page.getByText("Sign in to manage your organization's Teams seats.", {
			exact: true,
		})
	).toBeVisible();
	let snapshot = await readProof(page);
	expect(
		snapshot.requests.filter((request) =>
			request.path.startsWith("/api/billing/")
		)
	).toEqual([]);

	await page.goto(
		"/teams-billing-settings-proof.html?scenario=no-org&reset=true"
	);
	const chooseOrganization = page.getByRole("button", {
		exact: true,
		name: "Create or select an organization",
	});
	await expect(chooseOrganization).toBeVisible();
	await chooseOrganization.click();
	snapshot = await readProof(page);
	const expectedUrl = await page.evaluate(
		() => window.__teamsBillingSettingsProof.expectedOrganizationsUrl
	);
	expect(snapshot.externalUrls).toEqual([expectedUrl]);
	expect(new URL(snapshot.externalUrls[0] ?? "http://invalid").pathname).toBe(
		"/organizations"
	);
	expect(
		snapshot.tauriCalls.filter((call) => call.command === "open_external")
	).toEqual([{ args: { url: expectedUrl }, command: "open_external" }]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-teams-billing-no-organization.png"),
	});
});

test("retries the organization billing reads after a failed seat-status load", async ({
	page,
}) => {
	await page.goto(
		"/teams-billing-settings-proof.html?scenario=teams&failSeatsReadOnce=true&reset=true"
	);
	await expect(
		page.getByText(
			"We couldn't load your organization billing details. Check your connection and try again.",
			{ exact: true }
		)
	).toBeVisible();
	const retry = page.getByRole("button", { exact: true, name: "Try again" });
	await expect(retry).toBeVisible();
	const failedSnapshot = await readProof(page);
	const failedSeatReads = requestsFor(
		failedSnapshot,
		"GET",
		"/api/billing/seats"
	);
	expect(failedSeatReads).toHaveLength(1);
	expect(failedSnapshot.failures["GET /api/billing/seats"]).toEqual({
		message: "The billing seat service is temporarily unavailable.",
		remaining: 0,
		status: 503,
	});
	expect(failedSeatReads[0]?.headers.authorization).toBe(
		"Bearer teams-billing-proof-session-token"
	);
	expect(failedSnapshot.externalUrls).toEqual([]);
	expect(
		failedSnapshot.requests.filter((request) => request.method === "POST")
	).toEqual([]);
	await expect(
		page.getByRole("button", { exact: true, name: "Save seats" })
	).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-teams-billing-load-error.png"),
	});

	await retry.click();
	await expect(
		page.getByRole("button", { exact: true, name: "Save seats" })
	).toBeVisible();
	const snapshot = await readProof(page);
	expect(
		requestsFor(snapshot, "GET", "/api/billing/subscription-status")
	).toHaveLength(3);
	expect(requestsFor(snapshot, "GET", "/api/credits/wallet")).toHaveLength(3);
	expect(requestsFor(snapshot, "GET", "/api/control-plane/orgs")).toHaveLength(
		2
	);
	expect(requestsFor(snapshot, "GET", "/api/billing/seats")).toHaveLength(2);
	expect(snapshot.externalUrls).toEqual([]);
	expect(
		snapshot.requests.filter((request) => request.method === "POST")
	).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-teams-billing-load-recovered.png"),
	});
});

test("owner seat changes enforce floors and ceilings, preserve rejected input, retry, and persist", async ({
	page,
}) => {
	await openPlanSurface(page, "scenario=teams");
	const seats = page.getByRole("spinbutton", {
		exact: true,
		name: "Teams seats",
	});
	const save = page.getByRole("button", { exact: true, name: "Save seats" });
	await expect(seats).toHaveValue("5");
	await expect(seats).toHaveAttribute("min", "5");
	await expect(seats).toHaveAttribute("max", "50");
	await expect(page.getByText("$250.00/mo", { exact: false })).toBeVisible();

	await seats.fill("51");
	await save.click();
	await expect(
		page.getByText("Teams self-serve covers up to 50 seats", { exact: true })
	).toBeVisible();
	let snapshot = await readProof(page);
	expect(requestsFor(snapshot, "POST", "/api/billing/seats")).toEqual([]);

	await seats.fill("2");
	await save.click();
	await expect(seats).toHaveValue("5");
	await setServerRole(page, "member");
	await seats.fill("7");
	await save.click();
	await expect(
		page.getByText(
			"Only an organization owner or billing manager can do that.",
			{
				exact: true,
			}
		)
	).toBeVisible();
	await expect(seats).toHaveValue("7");
	await setServerRole(page, "owner");

	await armFailure(
		page,
		"POST /api/billing/seats",
		503,
		"The billing seat service is temporarily unavailable."
	);
	await save.click();
	await expect(
		page.getByText("The billing seat service is temporarily unavailable.", {
			exact: true,
		})
	).toBeVisible();
	await expect(seats).toHaveValue("7");
	await save.click();
	await expect(seats).toHaveValue("7");
	await expect(page.getByText(/7 billed · 4 active members/u)).toBeVisible();
	await expect(page.getByText("$350.00/mo", { exact: false })).toBeVisible();

	snapshot = await readProof(page);
	const seatWrites = requestsFor(snapshot, "POST", "/api/billing/seats");
	expect(seatWrites.map((request) => request.body)).toEqual([
		{ seats: 5 },
		{ seats: 7 },
		{ seats: 7 },
		{ seats: 7 },
	]);
	for (const write of seatWrites) {
		expect(write.headers.authorization).toBe(
			"Bearer teams-billing-proof-session-token"
		);
	}

	await page.reload();
	await expect(
		page.getByRole("spinbutton", { exact: true, name: "Teams seats" })
	).toHaveValue("7");
	await expect(page.getByText(/7 billed · 4 active members/u)).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-teams-billing-seats-saved-after-reload.png"),
	});
});

test("keeps billing mutations unavailable to organization members", async ({
	page,
}) => {
	await openPlanSurface(page, "scenario=teams&role=member");
	await expect(page.getByText(/Your organization is on Teams/u)).toBeVisible();
	await expect(page.getByText("$250.00/mo", { exact: false })).toBeVisible();
	await expect(
		page.getByRole("button", { exact: true, name: "Save seats" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { exact: true, name: "Manage billing" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { exact: true, name: "Review Teams" })
	).toHaveCount(0);
	await expect(
		page.getByRole("spinbutton", { exact: true, name: "Teams seats" })
	).toHaveCount(0);
	const snapshot = await readProof(page);
	expect(
		snapshot.requests.filter((request) => request.method === "POST")
	).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-teams-billing-member-read-only.png"),
	});
});

test("keeps billing mutations unavailable to organization admins", async ({
	page,
}) => {
	await openPlanSurface(page, "scenario=teams&role=admin");
	await expect(page.getByText("$250.00/mo", { exact: false })).toBeVisible();
	await expect(
		page.getByRole("button", { exact: true, name: "Save seats" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { exact: true, name: "Manage billing" })
	).toHaveCount(0);
});

test("keeps billing-manager controls available and renders each existing organization plan", async ({
	page,
}) => {
	await openPlanSurface(page, "scenario=teams&role=member&billing=true");
	await expect(
		page.getByRole("button", { exact: true, name: "Save seats" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { exact: true, name: "Manage billing" })
	).toBeVisible();
	expect(
		(await readProof(page)).requests.filter(
			(request) => request.method === "POST"
		)
	).toEqual([]);

	for (const plan of [
		{ amount: "$300.00/mo", label: "Business", scenario: "business" },
		{ amount: "$150.00/mo", label: "Teams Lite", scenario: "teams-lite" },
	]) {
		await openPlanSurface(page, `scenario=${plan.scenario}`);
		await expect(page.getByText(plan.label, { exact: true })).toBeVisible();
		await expect(page.getByText(plan.amount, { exact: false })).toBeVisible();
		await expect(
			page.getByRole("button", { exact: true, name: "Save seats" })
		).toBeVisible();
	}
});

test("opens the billing portal from the exact service URL and retries a failed portal read", async ({
	page,
}) => {
	await openPlanSurface(page, "scenario=teams");
	await armFailure(
		page,
		"GET /api/billing/portal",
		503,
		"The billing portal is temporarily unavailable."
	);
	const manage = page.getByRole("button", {
		exact: true,
		name: "Manage billing",
	});
	await manage.click();
	await expect(
		page.getByText("The billing portal is temporarily unavailable.", {
			exact: true,
		})
	).toBeVisible();
	await expect((await readProof(page)).externalUrls).toEqual([]);
	await manage.click();
	await expect
		.poll(async () => (await readProof(page)).externalUrls)
		.toEqual(["https://billing.fixture.test/portal/1"]);
	const snapshot = await readProof(page);
	expect(requestsFor(snapshot, "GET", "/api/billing/portal")).toEqual([
		expect.objectContaining({ body: null, method: "GET" }),
		expect.objectContaining({ body: null, method: "GET" }),
	]);
	expect(
		snapshot.tauriCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: { url: "https://billing.fixture.test/portal/1" },
			command: "open_external",
		},
	]);
});

test("reviews, cancels, validates, retries, and opens an organization plan checkout", async ({
	page,
}) => {
	await openPlanSurface(page, "scenario=checkout");
	const seats = page.getByRole("spinbutton", {
		exact: true,
		name: "Teams seats",
	});
	await seats.fill("7");
	await page.getByRole("button", { exact: true, name: "Review Teams" }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Review plan change" })
	).toBeVisible();
	await expect(
		dialog.getByText("7 member seats", { exact: true })
	).toBeVisible();
	await expect(dialog.getByText(/\$350\.00\/mo/u)).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-teams-billing-checkout-review.png"),
	});
	await dialog.getByRole("button", { exact: true, name: "Cancel" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(seats).toHaveValue("7");
	expect(
		requestsFor(
			await readProof(page),
			"POST",
			"/api/billing/checkout/organization"
		)
	).toEqual([]);

	await seats.fill("51");
	await page.getByRole("button", { exact: true, name: "Review Teams" }).click();
	await page
		.getByRole("button", { exact: true, name: "Continue to checkout" })
		.click();
	await expect(
		page.getByRole("alert").filter({
			hasText: "Teams self-serve covers up to 50 seats.",
		})
	).toBeVisible();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("button", { exact: true, name: "Cancel" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByText("Teams self-serve covers up to 50 seats.", { exact: true })
	).toHaveCount(0);
	await seats.fill("7");
	await page.getByRole("button", { exact: true, name: "Review Teams" }).click();
	await armFailure(
		page,
		"POST /api/billing/checkout/organization",
		503,
		"Checkout is temporarily unavailable."
	);
	const continueCheckout = page.getByRole("button", {
		exact: true,
		name: "Continue to checkout",
	});
	await continueCheckout.click();
	await expect(page.getByRole("alert")).toContainText(
		"Checkout is temporarily unavailable."
	);
	await expect(
		page.getByRole("dialog").getByText("7 member seats", { exact: true })
	).toBeVisible();
	await expect((await readProof(page)).externalUrls).toEqual([]);
	await continueCheckout.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const snapshot = await readProof(page);
	const checkouts = requestsFor(
		snapshot,
		"POST",
		"/api/billing/checkout/organization"
	);
	expect(checkouts.map((request) => request.body)).toEqual([
		{
			interval: "monthly",
			organizationId: "teams-billing-proof-org",
			planId: "teams",
			seats: 51,
		},
		{
			interval: "monthly",
			organizationId: "teams-billing-proof-org",
			planId: "teams",
			seats: 7,
		},
		{
			interval: "monthly",
			organizationId: "teams-billing-proof-org",
			planId: "teams",
			seats: 7,
		},
	]);
	for (const checkout of checkouts) {
		expect(checkout.headers.authorization).toBe(
			"Bearer teams-billing-proof-session-token"
		);
		expect(checkout.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
	}
	expect(snapshot.externalUrls).toEqual([
		"https://checkout.fixture.test/organization/1",
	]);
	expect(
		snapshot.tauriCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: { url: "https://checkout.fixture.test/organization/1" },
			command: "open_external",
		},
	]);
});
