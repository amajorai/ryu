import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

interface PublishRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
	status: number | null;
}

interface PublishProofSnapshot {
	externalNavigationAttempts: string[];
	listingCount: number;
	requests: PublishRequest[];
	tauriCalls: Array<{ args: unknown; command: string }>;
}

interface PublishProofBridge {
	armPublishMode: (
		mode:
			| "fail-once"
			| "github-install-required"
			| "hold-once"
			| "preflight-fail"
	) => void;
	failNextInstallStatus: () => void;
	resolveHeldPublish: () => void;
	snapshot: () => PublishProofSnapshot;
}

declare global {
	interface Window {
		__marketplacePublishProof: PublishProofBridge;
	}
}

function screenshotPath(name: string): string {
	return path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);
}

async function readProof(page: Page): Promise<PublishProofSnapshot> {
	return page.evaluate(() => window.__marketplacePublishProof.snapshot());
}

async function openPublisher(page: Page): Promise<void> {
	await page.goto("/marketplace-publish-dialog-proof.html");
	await expect(
		page.getByRole("heading", { name: "Publish App from GitHub" })
	).toBeVisible();
}

async function selectOffer(page: Page, label: string): Promise<void> {
	await page.getByLabel("Offer").click();
	await page.getByRole("option", { name: label, exact: true }).click();
}

function publishRequests(snapshot: PublishProofSnapshot): PublishRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === "/api/marketplace/github/publish"
	);
}

test.describe.configure({ timeout: 60_000 });

test("Free, one-time, subscription, and bounded offers submit exact pricing models", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill(" https://github.com/acme/free-app ");
	await dialog.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(page.getByText("Submitted for review")).toBeVisible();
	await expect(
		page.getByText(/Grade A · 100\/100 · marketplace-publish-1/u)
	).toBeVisible();
	await expect(page.getByText("listing-proof-1")).toBeVisible();
	let state = await readProof(page);
	expect(publishRequests(state)).toEqual([
		{
			body: { url: "https://github.com/acme/free-app" },
			method: "POST",
			path: "/api/marketplace/github/publish",
			query: {},
			status: 200,
		},
	]);

	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	const oneTime = page.getByRole("dialog");
	await oneTime
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/one-time-app");
	await selectOffer(page, "One-time purchase");
	await oneTime.getByLabel("Price").fill("12.34");
	await oneTime.getByLabel("Currency").fill("USD");
	await oneTime.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(page.getByText("listing-proof-2")).toBeVisible();

	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	const monthlySubscription = page.getByRole("dialog");
	await monthlySubscription
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/monthly-subscription-app");
	await selectOffer(page, "Subscription");
	await monthlySubscription.getByLabel("Price").fill("0.01");
	await monthlySubscription.getByLabel("Currency").fill("gbp");
	await monthlySubscription.getByLabel("Billing interval").click();
	await page.getByRole("option", { name: "Monthly", exact: true }).click();
	await monthlySubscription
		.getByRole("button", { name: "Submit GitHub package" })
		.click();
	await expect(page.getByText("listing-proof-3")).toBeVisible();

	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	const subscription = page.getByRole("dialog");
	await subscription
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/subscription-app");
	await selectOffer(page, "Subscription");
	await subscription.getByLabel("Price").fill("1.99");
	await subscription.getByLabel("Currency").fill("eur");
	await subscription.getByLabel("Billing interval").click();
	await page.getByRole("option", { name: "Yearly", exact: true }).click();
	await subscription
		.getByRole("button", { name: "Submit GitHub package" })
		.click();
	await expect(page.getByText("listing-proof-4")).toBeVisible();

	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	const bounded = page.getByRole("dialog");
	await bounded
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/bounded-app");
	await selectOffer(page, "Bounded updates");
	await bounded.getByLabel("Price").fill("3.50");
	await bounded.getByLabel("Currency").fill("CAD");
	await bounded.getByLabel("Included updates").fill("17");
	await bounded.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(page.getByText("listing-proof-5")).toBeVisible();
	state = await readProof(page);
	expect(publishRequests(state)).toEqual([
		{
			body: { url: "https://github.com/acme/free-app" },
			method: "POST",
			path: "/api/marketplace/github/publish",
			query: {},
			status: 200,
		},
		{
			body: {
				url: "https://github.com/acme/one-time-app",
				pricing: {
					amountMinor: 1234,
					currency: "usd",
					distribution: "github_release",
					model: "one_time",
				},
			},
			method: "POST",
			path: "/api/marketplace/github/publish",
			query: {},
			status: 200,
		},
		{
			body: {
				url: "https://github.com/acme/monthly-subscription-app",
				pricing: {
					amountMinor: 1,
					currency: "gbp",
					distribution: "github_release",
					interval: "month",
					model: "subscription",
				},
			},
			method: "POST",
			path: "/api/marketplace/github/publish",
			query: {},
			status: 200,
		},
		{
			body: {
				url: "https://github.com/acme/subscription-app",
				pricing: {
					amountMinor: 199,
					currency: "eur",
					distribution: "github_release",
					interval: "year",
					model: "subscription",
				},
			},
			method: "POST",
			path: "/api/marketplace/github/publish",
			query: {},
			status: 200,
		},
		{
			body: {
				url: "https://github.com/acme/bounded-app",
				pricing: {
					amountMinor: 350,
					currency: "cad",
					distribution: "github_release",
					maxUpdates: 17,
					model: "bounded_updates",
				},
			},
			method: "POST",
			path: "/api/marketplace/github/publish",
			query: {},
			status: 200,
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-pricing-payloads.png"),
	});
});

test("bounded updates accept the inclusive allowance limits and one-cent price", async ({
	page,
}) => {
	await openPublisher(page);
	let dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/bounded-minimum-app");
	await selectOffer(page, "Bounded updates");
	await dialog.getByLabel("Price").fill("0.01");
	await dialog.getByLabel("Currency").fill("USD");
	await dialog.getByLabel("Included updates").fill("1");
	await dialog.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(page.getByText("listing-proof-1")).toBeVisible();

	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/bounded-maximum-app");
	await selectOffer(page, "Bounded updates");
	await dialog.getByLabel("Price").fill("10.00");
	await dialog.getByLabel("Currency").fill("USD");
	await dialog.getByLabel("Included updates").fill("10000");
	await dialog.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(page.getByText("listing-proof-2")).toBeVisible();

	const state = await readProof(page);
	expect(
		publishRequests(state).map(({ body, status }) => ({ body, status }))
	).toEqual([
		{
			body: {
				url: "https://github.com/acme/bounded-minimum-app",
				pricing: {
					amountMinor: 1,
					currency: "usd",
					distribution: "github_release",
					maxUpdates: 1,
					model: "bounded_updates",
				},
			},
			status: 200,
		},
		{
			body: {
				url: "https://github.com/acme/bounded-maximum-app",
				pricing: {
					amountMinor: 1000,
					currency: "usd",
					distribution: "github_release",
					maxUpdates: 10_000,
					model: "bounded_updates",
				},
			},
			status: 200,
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-bounded-maximum-submitted.png"),
	});
});

test("empty URL, price, currency, and update counts block publishing with no writes", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	const submit = dialog.getByRole("button", { name: "Submit GitHub package" });
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Paste a GitHub repository or package URL."
	);
	await dialog.getByLabel("GitHub repository or package URL").fill("   ");
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Paste a GitHub repository or package URL."
	);
	expect(publishRequests(await readProof(page))).toEqual([]);

	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/validation-app");
	await selectOffer(page, "One-time purchase");
	const amount = dialog.getByLabel("Price");
	await amount.fill("0");
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Enter a positive price in your selected currency."
	);
	await amount.fill("-1");
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Enter a positive price in your selected currency."
	);
	await amount.fill("12.345");
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Price must use no more than two decimal places."
	);
	await amount.fill("90071992547409.92");
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Price is too large to represent safely in minor units."
	);
	await amount.fill("12.34");
	await dialog.getByLabel("Currency").fill("US1");
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Currency must be a three-letter ISO code, such as USD."
	);
	expect(publishRequests(await readProof(page))).toEqual([]);

	await selectOffer(page, "Bounded updates");
	await dialog.getByLabel("Currency").fill("USD");
	const updates = dialog.getByLabel("Included updates");
	for (const value of ["0", "10001", "3.5"]) {
		await updates.fill(value);
		await submit.click();
		await expect(dialog.getByRole("alert")).toHaveText(
			"Included updates must be an integer from 1 to 10,000."
		);
		expect(publishRequests(await readProof(page))).toEqual([]);
	}
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath(
			"marketplace-publish-invalid-price-currency-updates.png"
		),
	});
});

test("a non-A preflight blocks submission and a Grade A retry succeeds", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	const repositoryUrl = "https://github.com/acme/below-grade-app";
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill(repositoryUrl);
	await page.evaluate(() =>
		window.__marketplacePublishProof.armPublishMode("preflight-fail")
	);
	await dialog.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(dialog.getByText("Preflight: Grade F · 60/100")).toBeVisible();
	await expect(
		dialog.getByText(/Only Grade A packages enter Ryu's admin review queue/u)
	).toBeVisible();
	await expect(
		dialog.getByText(/Uses shared controls instead of local copies:/u)
	).toBeVisible();
	await expect(page.getByText("Submitted for review")).toHaveCount(0);
	let state = await readProof(page);
	expect(state.listingCount).toBe(0);
	expect(
		publishRequests(state).map(({ body, status }) => ({ body, status }))
	).toEqual([{ body: { url: repositoryUrl }, status: 422 }]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("desktop-marketplace-publish-preflight-blocked.png"),
	});

	await dialog.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(page.getByText("Submitted for review")).toBeVisible();
	await expect(page.getByText("listing-proof-1")).toBeVisible();
	state = await readProof(page);
	expect(state.listingCount).toBe(1);
	expect(
		publishRequests(state).map(({ body, status }) => ({ body, status }))
	).toEqual([
		{ body: { url: repositoryUrl }, status: 422 },
		{ body: { url: repositoryUrl }, status: 200 },
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-preflight-recovered.png"),
	});
});

test("publish pending state locks Submit and transient failure retries the identical retained draft", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	const repositoryUrl = "https://github.com/acme/retry-app";
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill(repositoryUrl);
	await selectOffer(page, "One-time purchase");
	await dialog.getByLabel("Price").fill("5.19");
	await dialog.getByLabel("Currency").fill("USD");
	await page.evaluate(() =>
		window.__marketplacePublishProof.armPublishMode("fail-once")
	);
	const submit = dialog.getByRole("button", { name: "Submit GitHub package" });
	await submit.click();
	await expect(
		page.getByText("Marketplace fixture is temporarily unavailable.")
	).toBeVisible();
	await expect(
		dialog.getByLabel("GitHub repository or package URL")
	).toHaveValue(repositoryUrl);
	await expect(dialog.getByLabel("Price")).toHaveValue("5.19");
	let state = await readProof(page);
	const body = {
		url: repositoryUrl,
		pricing: {
			amountMinor: 519,
			currency: "usd",
			distribution: "github_release",
			model: "one_time",
		},
	};
	expect(
		publishRequests(state).map(({ body: requestBody, status }) => ({
			body: requestBody,
			status,
		}))
	).toEqual([{ body, status: 503 }]);
	await submit.click();
	await expect(page.getByText("Submitted for review")).toBeVisible();
	state = await readProof(page);
	expect(
		publishRequests(state).map(({ body: requestBody, status }) => ({
			body: requestBody,
			status,
		}))
	).toEqual([
		{ body, status: 503 },
		{ body, status: 200 },
	]);

	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	const pendingDialog = page.getByRole("dialog");
	await pendingDialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/pending-app");
	await page.evaluate(() =>
		window.__marketplacePublishProof.armPublishMode("hold-once")
	);
	await pendingDialog
		.getByRole("button", { name: "Submit GitHub package" })
		.click();
	const validating = page.getByRole("button", {
		name: "Checking Grade A preflight…",
	});
	await expect(validating).toBeDisabled();
	state = await readProof(page);
	expect(publishRequests(state).at(-1)).toMatchObject({
		body: { url: "https://github.com/acme/pending-app" },
		method: "POST",
		status: null,
	});
	await page.evaluate(() =>
		window.__marketplacePublishProof.resolveHeldPublish()
	);
	await expect(page.getByText("listing-proof-2")).toBeVisible();
});

test("private repository install handoff captures openExternal and retries exact state/proof", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	const repositoryUrl = "https://github.com/acme/private-app";
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill(repositoryUrl);
	await page.evaluate(() =>
		window.__marketplacePublishProof.armPublishMode("github-install-required")
	);
	await dialog.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(
		page.getByText(
			"GitHub needs one-time repository access. Install the Ryu App, then check again."
		)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Install GitHub access", exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-github-install-required.png"),
	});

	await page.evaluate(() =>
		window.__marketplacePublishProof.failNextInstallStatus()
	);
	await page
		.getByRole("button", { name: "Install GitHub access", exact: true })
		.click();
	await expect(
		page.getByText(
			"Finish the GitHub App installation, then choose Check again."
		)
	).toBeVisible();
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(
		page.getByText("GitHub App installation is not ready yet.")
	).toBeVisible();
	await page.getByRole("button", { name: "Check again", exact: true }).click();
	await expect(page.getByText("Submitted for review")).toBeVisible();
	await expect(page.getByText("listing-proof-1")).toBeVisible();
	const state = await readProof(page);
	const installationUrl =
		"https://github.com/apps/ryu-marketplace/installations/new";
	expect(
		state.tauriCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: { url: installationUrl },
			command: "open_external",
		},
	]);
	expect(state.externalNavigationAttempts).toEqual([]);
	expect(
		state.requests.filter(
			(request) =>
				request.method === "GET" &&
				request.path === "/api/marketplace/github/install/status"
		)
	).toEqual([
		{
			body: null,
			method: "GET",
			path: "/api/marketplace/github/install/status",
			query: {
				repository: "acme/private-app",
				state: "github-state-proof-001",
			},
			status: 409,
		},
		{
			body: null,
			method: "GET",
			path: "/api/marketplace/github/install/status",
			query: {
				repository: "acme/private-app",
				state: "github-state-proof-001",
			},
			status: 200,
		},
	]);
	expect(publishRequests(state)).toEqual([
		{
			body: { url: repositoryUrl },
			method: "POST",
			path: "/api/marketplace/github/publish",
			query: {},
			status: 403,
		},
		{
			body: {
				url: repositoryUrl,
				installationProof: "local-installation-proof-token",
			},
			method: "POST",
			path: "/api/marketplace/github/publish",
			query: {},
			status: 200,
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-github-install-completed.png"),
	});
});

test("sign-in is required before publishing and the dialog close button resets the draft", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/unsigned-app");
	await selectOffer(page, "One-time purchase");
	await dialog.getByLabel("Price").fill("4.25");
	await page.evaluate(() => localStorage.removeItem("ryu_session_token"));
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByTestId("dialog-open-state")).toHaveText("closed");
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();

	const reopened = page.getByRole("dialog");
	await expect(
		reopened.getByText(
			"Sign in to your Ryu account to publish to the marketplace."
		)
	).toBeVisible();
	await expect(
		reopened.getByRole("button", { name: "Submit GitHub package" })
	).toBeDisabled();
	await expect(
		reopened.getByLabel("GitHub repository or package URL")
	).toHaveValue("");
	await expect(reopened.getByLabel("Offer")).toContainText("Free");
	expect(publishRequests(await readProof(page))).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-sign-in-required.png"),
	});
});

test("Escape closes and resets the dialog without a publish request", async ({
	page,
}) => {
	await openPublisher(page);
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/escape-cancelled-app");
	await selectOffer(page, "Subscription");
	await dialog.getByLabel("Price").fill("8.25");
	await dialog.getByLabel("Currency").fill("JPY");
	await dialog.getByLabel("Billing interval").click();
	await page.getByRole("option", { name: "Yearly", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dialog-open-state")).toHaveText("closed");
	expect(publishRequests(await readProof(page))).toEqual([]);

	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	const reopened = page.getByRole("dialog");
	await expect(
		reopened.getByLabel("GitHub repository or package URL")
	).toHaveValue("");
	await expect(reopened.getByLabel("Offer")).toContainText("Free");
	await selectOffer(page, "Subscription");
	await expect(reopened.getByLabel("Price")).toHaveValue("");
	await expect(reopened.getByLabel("Currency")).toHaveValue("USD");
	await expect(reopened.getByLabel("Billing interval")).toContainText(
		"Monthly"
	);
	await selectOffer(page, "Bounded updates");
	await expect(reopened.getByLabel("Included updates")).toHaveValue("3");
	expect(publishRequests(await readProof(page))).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("marketplace-publish-escape-reset.png"),
	});
});

test("Cancel and Done close the dialog and reset repository and offer drafts", async ({
	page,
}) => {
	await openPublisher(page);
	let dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/cancelled-app");
	await selectOffer(page, "Subscription");
	await dialog.getByLabel("Price").fill("7.50");
	await dialog.getByLabel("Currency").fill("CAD");
	await dialog.getByLabel("Billing interval").click();
	await page.getByRole("option", { name: "Yearly", exact: true }).click();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByTestId("dialog-open-state")).toHaveText("closed");
	expect(publishRequests(await readProof(page))).toEqual([]);

	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	dialog = page.getByRole("dialog");
	await expect(
		dialog.getByLabel("GitHub repository or package URL")
	).toHaveValue("");
	await expect(dialog.getByLabel("Offer")).toContainText("Free");
	await expect(
		dialog.getByText("Free packages need no seller payout setup.")
	).toBeVisible();
	await selectOffer(page, "Subscription");
	await expect(dialog.getByLabel("Price")).toHaveValue("");
	await expect(dialog.getByLabel("Currency")).toHaveValue("USD");
	await expect(dialog.getByLabel("Billing interval")).toContainText("Monthly");
	await selectOffer(page, "Bounded updates");
	await expect(dialog.getByLabel("Included updates")).toHaveValue("3");
	await selectOffer(page, "Free");
	await dialog
		.getByLabel("GitHub repository or package URL")
		.fill("https://github.com/acme/done-reset-app");
	await dialog.getByRole("button", { name: "Submit GitHub package" }).click();
	await expect(page.getByText("Submitted for review")).toBeVisible();
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await expect(page.getByTestId("dialog-open-state")).toHaveText("closed");
	await page
		.getByRole("button", { name: "Open publisher", exact: true })
		.click();
	dialog = page.getByRole("dialog");
	await expect(
		dialog.getByLabel("GitHub repository or package URL")
	).toHaveValue("");
	await expect(dialog.getByLabel("Offer")).toContainText("Free");
	await expect(page.getByText("Submitted for review")).toHaveCount(0);
	await selectOffer(page, "Subscription");
	await expect(dialog.getByLabel("Price")).toHaveValue("");
	await expect(dialog.getByLabel("Currency")).toHaveValue("USD");
	await expect(dialog.getByLabel("Billing interval")).toContainText("Monthly");
	await selectOffer(page, "Bounded updates");
	await expect(dialog.getByLabel("Included updates")).toHaveValue("3");
});
