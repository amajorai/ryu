// Continues ugc-panel-interactions-proof.spec.ts (split under the file token limit); helpers live in ugc-panel-interactions-proof.helpers.ts.

import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
	expectAuthenticatedLocalRequests,
	installFixture,
	lastRequest,
	openPanel,
	requestsFor,
	waitForRequest,
} from "./ugc-panel-interactions-proof.data.ts";
import {
	createFixture,
	EVIDENCE_DIRECTORY,
	STORY_URL,
} from "./ugc-panel-interactions-proof.helpers.ts";

test.beforeAll(async () => {
	await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
});

test("payout filters require confirmation and only record local settlement state", async ({
	page,
}) => {
	const fixture = createFixture();
	await installFixture(page, fixture);
	await openPanel(page);
	await page.getByRole("tab", { name: "Payouts", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();

	await page.getByLabel("Filter payouts by status").selectOption("accrued");
	await waitForRequest(fixture, "GET", "/api/ugc/payouts?status=accrued");
	const accruedRow = page.getByRole("row").filter({ hasText: "$25.00" });
	await accruedRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	let confirm = page.getByRole("alertdialog", { name: "Approve this payout?" });
	await expect(confirm).toContainText("$25.00 to Ada Lovelace");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toBeHidden();
	expect(
		requestsFor(fixture, "POST", "/api/ugc/payouts/payout-accrued/approve")
	).toHaveLength(0);
	await accruedRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	confirm = page.getByRole("alertdialog", { name: "Approve this payout?" });
	await confirm.getByRole("button", { name: "Approve payout" }).click();
	await expect(confirm).toBeHidden();
	await expect
		.poll(
			() => fixture.payouts.find((row) => row.id === "payout-accrued")?.status
		)
		.toBe("approved");
	expect(
		requestsFor(fixture, "POST", "/api/ugc/payouts/payout-accrued/approve")
	).toHaveLength(1);

	await page.getByLabel("Filter payouts by status").selectOption("approved");
	await waitForRequest(fixture, "GET", "/api/ugc/payouts?status=approved");
	const paidRow = page.getByRole("row").filter({ hasText: "$42.00" });
	await paidRow.getByRole("button", { name: "Mark paid", exact: true }).click();
	confirm = page.getByRole("alertdialog", {
		name: "Mark this payout as paid?",
	});
	await expect(confirm).toContainText("This cannot be undone.");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toBeHidden();
	expect(
		requestsFor(fixture, "POST", "/api/ugc/payouts/payout-approved/paid")
	).toHaveLength(0);
	await paidRow.getByRole("button", { name: "Mark paid", exact: true }).click();
	confirm = page.getByRole("alertdialog", {
		name: "Mark this payout as paid?",
	});
	await expect(confirm).toBeVisible();
	await expect(confirm).toHaveCSS("opacity", "1");
	const confirmBounds = await confirm.boundingBox();
	expect(confirmBounds?.width).toBeGreaterThan(0);
	expect(confirmBounds?.height).toBeGreaterThan(0);
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/payout-confirmation.png`,
		animations: "disabled",
	});
	await confirm.getByRole("button", { name: "Mark paid" }).click();
	await expect(confirm).toBeHidden();
	await expect
		.poll(
			() => fixture.payouts.find((row) => row.id === "payout-approved")?.status
		)
		.toBe("paid");
	await expect
		.poll(
			() =>
				fixture.submissions.find((row) => row.id === "submission-approved")
					?.status
		)
		.toBe("paid");
	expect(
		requestsFor(fixture, "POST", "/api/ugc/payouts/payout-approved/paid")
	).toHaveLength(1);
	expect(
		lastRequest(fixture, "POST", "/api/ugc/payouts/payout-approved/paid").body
	).toBeNull();
	await page.getByLabel("Filter payouts by status").selectOption("paid");
	await waitForRequest(fixture, "GET", "/api/ugc/payouts?status=paid");
	await expect(
		page.getByRole("row").filter({ hasText: "$42.00" })
	).toContainText("paid");
	await page.getByRole("tab", { name: "Campaigns", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Aurora Spring Launch" })
	).toBeVisible();
	expectAuthenticatedLocalRequests(fixture);
});

test("managed Composio status links to Gateway keys and never calls UGC key routes", async ({
	page,
}) => {
	const fixture = createFixture(false);
	await installFixture(page, fixture);
	await openPanel(page);
	await expect(
		page.getByText(/No managed Composio provider is configured on this node/u)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Gateway keys", exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Gateway keys", exact: true }).click();
	await expect(page.getByTestId("gateway-intent")).toHaveAttribute(
		"data-open",
		"true"
	);
	await expect(page.getByTestId("gateway-intent")).toHaveAttribute(
		"data-section",
		"keys"
	);
	await page
		.getByRole("button", {
			name: "Composio settings in Gateway → Keys",
			exact: true,
		})
		.click();
	await expect(page.getByTestId("gateway-intent")).toHaveAttribute(
		"data-section",
		"keys"
	);

	const paths = fixture.requests.map((request) => request.path);
	expect(paths.some((path) => /\/settings(?:\/|$)/u.test(path))).toBe(false);
	expect(paths.some((path) => path.includes("composio-key"))).toBe(false);
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true
	);
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/managed-provider-gateway-keys-entry.png`,
	});
	expectAuthenticatedLocalRequests(fixture);
});

test("disabled UGC app shows the enable explanation without reaching its sidecar", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	await page.goto(`${STORY_URL}?disabled=1`);
	await expect(
		page.getByText(/Enable the UGC app to track creator campaigns/u)
	).toBeVisible();
	await expect(
		page.getByRole("tab", { name: "Campaigns", exact: true })
	).toHaveCount(0);
	expect(fixture.requests).toEqual([]);
	expect(fixture.unexpectedRoutes).toEqual([]);
	await page.screenshot({
		path: `${EVIDENCE_DIRECTORY}/disabled-app-state.png`,
	});
});
