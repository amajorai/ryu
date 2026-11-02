import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const paths = [
	"/api/marketplace/licenses",
	"/api/seller/status",
	"/api/marketplace/membership/publisher-report",
];
function payload(pathname: string, scope: string) {
	if (pathname.endsWith("/licenses")) {
		return {
			licenses: [
				{
					id: scope,
					buyerOrgId: scope,
					buyerUserId: scope,
					itemKind: "plugin",
					itemId: "example",
					itemName: `${scope} license`,
					itemVersion: "1.0",
					priceMinor: 1999,
					platformFeeMinor: 100,
					currency: "usd",
					status: "active",
					purchasedAt: "2026-09-01T00:00:00Z",
					stripePaymentIntentId: "fixture",
					entitlementUntil: null,
					stripeSubscriptionId: null,
				},
			],
		};
	}
	if (pathname.endsWith("/status")) {
		return {
			stripeConnectAccountId: scope,
			payoutsEnabled: true,
			onboardingStatus: "complete",
		};
	}
	return { organizationId: scope, currencies: [], eligibleListingCount: 0 };
}
test("Marketplace readers coalesce focus refresh and isolate account and organization switches", async ({
	page,
}) => {
	const calls = new Map<string, number>();
	let scope = "Alpha";
	let hold = false;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const cancelled: string[] = [];
	page.on("requestfailed", (request) => {
		if (paths.includes(new URL(request.url()).pathname)) {
			cancelled.push(request.url());
		}
	});
	await page.route("**/api/**", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (!pathname.startsWith("/api/")) {
			return route.continue();
		}
		const captured = scope;
		calls.set(pathname, (calls.get(pathname) ?? 0) + 1);
		if (hold && captured === "Alpha") {
			await pending;
		}
		await route.fulfill({ json: payload(pathname, captured) });
	});
	try {
		await page.goto("/marketplace-org-performance-proof.html");
		await expect(
			page.getByText("Alpha license", { exact: true })
		).toBeVisible();
		for (const pathname of paths) {
			expect(calls.get(pathname)).toBe(1);
		}
		hold = true;
		await page.evaluate(() => {
			for (let i = 0; i < 10; i++) {
				window.dispatchEvent(new Event("focus"));
			}
		});
		for (const pathname of paths) {
			await expect.poll(() => calls.get(pathname)).toBe(2);
		}
		scope = "Beta";
		await page
			.getByRole("button", { name: "Account Beta", exact: true })
			.click();
		await expect(page.getByText("Beta license", { exact: true })).toBeVisible();
		await expect.poll(() => cancelled.length).toBe(3);
		release();
		await expect(page.getByText("Alpha license", { exact: true })).toHaveCount(
			0
		);
		await expect(page.locator("html")).toHaveAttribute("data-seller", "Beta");
		await expect(page.locator("html")).toHaveAttribute(
			"data-report-org",
			"Beta"
		);
		scope = "Other";
		await page
			.getByRole("button", { name: "Other organization", exact: true })
			.click();
		await expect(
			page.getByText("Other license", { exact: true })
		).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("data-seller", "Other");
		await expect(page.locator("html")).toHaveAttribute(
			"data-report-org",
			"Other"
		);
		for (const pathname of paths) {
			expect(calls.get(pathname)).toBe(4);
		}
		await page.screenshot({
			path: proofEvidencePath(
				"performance-sweep/marketplace-org-cache-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
		await page.getByRole("button", { name: "Sign out", exact: true }).click();
		await expect(
			page.getByText("Sign in to view your licenses", { exact: true })
		).toBeVisible();
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		for (const pathname of paths) {
			expect(calls.get(pathname)).toBe(4);
		}
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("seller reports share scoped reads and discard pre-resolution snapshots", async ({
	page,
}) => {
	let scope = "Alpha";
	let reads = 0;
	let cancelled = 0;
	let resolved = false;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const report = (owner: string) => ({
		id: `report-${owner}`,
		itemId: "listing",
		itemKind: "plugin",
		itemName: `${owner} listing`,
		reason: "broken",
		details: "Fixture report",
		status: "open",
	});
	page.on("requestfailed", (request) => {
		if (request.url().includes("/reports/seller")) {
			cancelled++;
		}
	});
	await page.route("**/api/marketplace/reports/**", async (route) => {
		if (route.request().url().endsWith("/resolve")) {
			resolved = true;
			return route.fulfill({
				json: { report: { ...report(scope), status: "resolved" } },
			});
		}
		const index = ++reads;
		const reports = resolved ? [] : [report(scope)];
		if (index === 1 || index === 3) {
			await pending;
		}
		return route.fulfill({ json: { reports } });
	});
	try {
		await page.goto("/marketplace-org-performance-proof.html?reports");
		await expect.poll(() => reads).toBe(1);
		scope = "Beta";
		await page
			.getByRole("button", { name: "Account Beta", exact: true })
			.click();
		await expect(page.getByText("Beta listing", { exact: true })).toBeVisible();
		await expect.poll(() => cancelled).toBe(1);
		expect(reads).toBe(2);
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect.poll(() => reads).toBe(3);
		await page.getByRole("button", { name: "Resolve", exact: true }).click();
		await expect.poll(() => cancelled).toBe(2);
		await expect(
			page.getByText("No open reports.", { exact: true })
		).toBeVisible();
		expect(reads).toBe(4);
		release();
		await page.waitForTimeout(50);
		await expect(page.getByText("Beta listing", { exact: true })).toHaveCount(
			0
		);
		await expect(page.getByText("Alpha listing", { exact: true })).toHaveCount(
			0
		);
		await page.screenshot({
			path: proofEvidencePath("performance-sweep/seller-reports-completed.png"),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
