import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readAuthVaultSlot } from "./harness/desktop-secret-slots.ts";
import {
	installNativeVaultBridge,
	openLink,
	plaintextVault,
} from "./marketplace-detail-proof.data.ts";
import {
	accountReviewTransport,
	buyerId,
	install,
	listingId,
	more,
	open,
} from "./marketplace-detail-proof.helpers.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

for (const held of ["read", "save"] as const) {
	test(`review account switch reload fences held A ${held} and B retries with exact identity`, async ({
		page,
	}, testInfo) => {
		await install(page, { accountLifetime: true });
		const slots = await installNativeVaultBridge(page);
		const fixture = await accountReviewTransport(page, held);
		await open(page, "?account-lifetime");
		// The seeded plaintext vault migrated into the sealed slot.
		await expect
			.poll(() => readAuthVaultSlot(slots))
			.toMatchObject({
				activeUserId: buyerId,
				activeToken: "marketplace-detail-session-token",
			});
		await expect.poll(() => plaintextVault(page)).toEqual([null, null, null]);
		await more(page);
		if (held === "save") {
			await page.getByRole("button", { name: "4 stars", exact: true }).click();
			await page
				.getByRole("textbox", { name: "Review title" })
				.fill("Account A held save");
			await page
				.getByRole("textbox", { name: "Review body" })
				.fill("Account A saved body");
			await page
				.getByRole("button", { name: "Post review", exact: true })
				.click();
		}
		await expect.poll(fixture.isHeld).toBe(true);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page
			.getByRole("button", { name: "Review account controls", exact: true })
			.click();
		await page
			.getByRole("menuitem", {
				name: "Review buyer avatar Review buyer",
				exact: true,
			})
			.click();
		const secondAccount = page.getByRole("menuitem").filter({
			has: page.getByText("second@example.invalid", { exact: true }),
		});
		await expect(secondAccount).toHaveCount(1);
		await expect(
			secondAccount.getByText("Second review buyer", { exact: true })
		).toBeVisible();
		const documentBefore = await page.evaluate(() => performance.timeOrigin);
		await Promise.all([
			page.waitForEvent("load"),
			secondAccount.getByText("Second review buyer", { exact: true }).click(),
		]);
		expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
			documentBefore
		);
		expect(readAuthVaultSlot(slots)).toMatchObject({
			activeUserId: "fixture-review-second-buyer",
			activeToken: "marketplace-detail-second-token",
		});
		expect(
			readAuthVaultSlot(slots)?.accounts.map((account) => account.userId)
		).toEqual([buyerId, "fixture-review-second-buyer"]);
		await expect.poll(() => plaintextVault(page)).toEqual([null, null, null]);
		await fixture.release();
		await page.getByText("Harbor Review Kit", { exact: true }).click();
		await more(page);
		await expect(page.getByRole("alert")).toContainText(
			"Couldn't load reviews"
		);
		await expect(
			page.getByRole("textbox", { name: "Review title" })
		).toHaveValue("");
		await expect(
			page.getByRole("button", { name: "Post review", exact: true })
		).toBeDisabled();
		await expect(page.getByText("Review posted.", { exact: true })).toHaveCount(
			0
		);
		await page
			.getByRole("button", { name: "Retry reviews", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(
			page.getByRole("textbox", { name: "Review title" })
		).toHaveValue("");
		await expect(
			page.getByRole("button", { name: "Delete", exact: true })
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Update review", exact: true })
		).toHaveCount(0);
		await page.getByRole("button", { name: "5 stars", exact: true }).click();
		await page
			.getByRole("textbox", { name: "Review title" })
			.fill("Account B current review");
		await page
			.getByRole("textbox", { name: "Review body" })
			.fill("Account B current body");
		await page
			.getByRole("button", { name: "Post review", exact: true })
			.click();
		await expect(
			page.getByText("Second account review write denied", { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: "Review title" })
		).toHaveValue("Account B current review");
		await page
			.getByRole("button", { name: "Post review", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Update review", exact: true })
		).toBeVisible();
		await page.reload();
		await page.getByText("Harbor Review Kit", { exact: true }).click();
		await more(page);
		await expect(
			page.getByRole("textbox", { name: "Review title" })
		).toHaveValue("Account B current review");
		await expect(
			page.getByRole("textbox", { name: "Review body" })
		).toHaveValue("Account B current body");
		expect(
			fixture.readReviews().filter((review) => review.userId === buyerId)
		).toHaveLength(1);
		expect(
			fixture
				.readReviews()
				.filter((review) => review.userId === "fixture-review-second-buyer")
		).toHaveLength(1);
		const writes = fixture.requests.filter(
			(request) => request.method === "POST"
		);
		expect(
			writes.map((request) => [request.authorization, request.status])
		).toEqual([
			...(held === "save"
				? [["Bearer marketplace-detail-session-token", 200]]
				: []),
			["Bearer marketplace-detail-second-token", 403],
			["Bearer marketplace-detail-second-token", 200],
		]);
		expect(
			fixture.requests.filter(
				(request) =>
					request.authorization === "Bearer marketplace-detail-session-token" &&
					request.method === "GET"
			)
		).toHaveLength(1);
		expect(
			fixture.requests.filter(
				(request) =>
					request.authorization === "Bearer marketplace-detail-second-token" &&
					request.method === "GET"
			)
		).toHaveLength(4);
		await page
			.getByRole("textbox", { name: "Review title" })
			.scrollIntoViewIfNeeded();
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: testInfo.outputPath(`marketplace-account-${held}-recovered.png`),
		});
	});
}

test("production Store listing disclosure, external actions, screenshot viewer, prompt copy and disabled runnable state work", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	await page
		.getByRole("button", { name: /Summarize the selected workspace/ })
		.click();
	expect(
		await page.evaluate(
			() =>
				/* SAFETY: The installed clipboard writeText callback stores its native string input in this private slot; this read follows the actual copy action. No listing or HTTP response contract is asserted. */ (
					window as typeof window & { __marketplaceProofClipboard: string }
				).__marketplaceProofClipboard
		)
	).toBe("Summarize the selected workspace");
	await openLink(page, "Configure workspace", "/__proof/links/setup");
	await page.getByRole("button", { name: "More options", exact: true }).click();
	await openLink(page, "Website", "/__proof/links/site");
	await openLink(page, "View topic source", "/__proof/links/topic");
	await more(page);
	await expect(
		page.getByRole("switch", { name: "Read workspace enabled" })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Read workspace enabled" })
	).toBeChecked();
	await openLink(page, "Privacy Policy", "/__proof/links/privacy");
	await openLink(page, "Terms of Service", "/__proof/links/terms");
	await page
		.getByRole("button", {
			name: "Harbor Review Kit screenshot 1",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("img", { name: /screenshot 1/ }).last()
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "More details", exact: true })
	).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("dialog")).toHaveCount(1);
	await page.getByRole("dialog").screenshot({
		animations: "disabled",
		path: proofEvidencePath(
			"test-coverage-sweep-20260924/evidence/desktop-marketplace-screenshot-returned-to-listing.png"
		),
	});
	await page.getByRole("button", { name: "More details", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Reviews", exact: true })
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(
		fixture.requests.filter(
			(request) =>
				request.method !== "GET" &&
				["/api/marketplace/reviews", "/api/plugins/catalog/install"].includes(
					request.path
				)
		)
	).toHaveLength(0);
});

test("reviews validate rating, preserve denied drafts, paginate with retry, update/delete exact authenticated payloads and reload accepted state", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	await more(page);
	await page.getByRole("button", { name: "Post review", exact: true }).click();
	expect(
		fixture.requests.filter(
			(request) =>
				request.method === "POST" && request.path === "/api/marketplace/reviews"
		)
	).toHaveLength(0);
	await page.getByRole("button", { name: "4 stars", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Review title" })
		.fill("  Useful kit  ");
	await page
		.getByRole("textbox", { name: "Review body" })
		.fill("  Works for our workspace.  ");
	fixture.fail("POST", "/api/marketplace/reviews", 403, {
		requiresPurchase: true,
		message: "Only verified purchasers",
	});
	await page.getByRole("button", { name: "Post review", exact: true }).click();
	await expect(
		page.getByText(/Only verified purchasers can review/)
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Review title" })).toHaveValue(
		"  Useful kit  "
	);
	const expected = {
		kind: "bundle",
		id: listingId,
		rating: 4,
		title: "Useful kit",
		body: "Works for our workspace.",
	};
	expect(
		fixture.requests
			.filter(
				(request) =>
					request.method === "POST" &&
					request.path === "/api/marketplace/reviews"
			)
			.at(-1)?.body
	).toEqual(expected);
	fixture.fail("POST", "/api/marketplace/reviews", 403, {
		error: "review_locked",
		message: "Reviews are temporarily locked.",
	});
	await page.getByRole("button", { name: "Post review", exact: true }).click();
	await expect(
		page.getByText("Reviews are temporarily locked.", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Review body" })).toHaveValue(
		"  Works for our workspace.  "
	);
	await page.getByRole("button", { name: "Post review", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Update review", exact: true })
	).toBeVisible();
	expect(
		fixture.readReviews().filter((review) => review.userId === buyerId)
	).toHaveLength(1);
	await page.getByRole("button", { name: "5 stars", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Review title" })
		.fill("Updated kit review");
	await page
		.getByRole("button", { name: "Update review", exact: true })
		.click();
	await expect(
		page.getByText("Updated kit review", { exact: true })
	).toBeVisible();
	fixture.fail(
		"GET",
		`/api/marketplace/reviews?kind=bundle&id=${listingId}&limit=20&cursor=20`
	);
	await page.getByRole("button", { name: "Load more", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Couldn't load more reviews"
	);
	await expect(
		page.getByRole("button", { name: "Load more", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Load more", exact: true }).click();
	await expect(
		page.getByText("Fixture review 22", { exact: true })
	).toBeVisible();
	await page.reload();
	await page.getByText("Harbor Review Kit", { exact: true }).click();
	await more(page);
	await expect(page.getByRole("textbox", { name: "Review title" })).toHaveValue(
		"Updated kit review"
	);
	const proof = proofEvidencePath(
		"test-coverage-sweep-20260924/evidence/desktop-marketplace-review-persisted.png"
	);
	await mkdir(path.dirname(proof), { recursive: true });
	await page
		.getByRole("textbox", { name: "Review title" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({ animations: "disabled", path: proof });
	fixture.fail(
		"DELETE",
		`/api/marketplace/reviews?kind=bundle&id=${listingId}`
	);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		page.getByText("Temporary listing request failure", { exact: true })
	).toBeVisible();
	expect(
		fixture.readReviews().some((review) => review.userId === buyerId)
	).toBe(true);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Post review", exact: true })
	).toBeVisible();
	expect(
		fixture.readReviews().some((review) => review.userId === buyerId)
	).toBe(false);
	expect(
		fixture.requests
			.filter((request) => request.path.startsWith("/api/marketplace/reviews"))
			.every(
				(request) =>
					request.authorization === "Bearer marketplace-detail-session-token"
			)
	).toBe(true);
});

test("minimal listings retain the review entry and signed-out viewers cannot author reviews", async ({
	page,
}) => {
	const fixture = await install(page, { signedOut: true, minimal: true });
	await open(page, "?signed-out");
	await more(page);
	await expect(
		page.getByText("Sign in to write a review.", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Review title" })).toHaveCount(
		0
	);
	await expect(
		page.getByRole("button", { name: "Post review", exact: true })
	).toHaveCount(0);
	expect(
		fixture.requests.filter(
			(request) =>
				request.method !== "GET" && request.path === "/api/marketplace/reviews"
		)
	).toHaveLength(0);
});

test("bundle install exposes a required denial, retries the exact Core install and reads accepted plugin state", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	fixture.fail("POST", "/api/plugins/catalog/install", 403, {
		error: "forbidden",
		message: "Plugin installation is not permitted.",
	});
	await page
		.getByRole("button", { name: "Install bundle", exact: true })
		.click();
	await expect(
		page.getByText("Bundle installed with required items missing", {
			exact: true,
		})
	).toBeVisible();
	expect(fixture.installed.size).toBe(0);
	await page
		.getByRole("button", { name: "Install bundle", exact: true })
		.click();
	await expect
		.poll(() => fixture.installed.has("com.example.review-kit"))
		.toBe(true);
	const installed = await page.evaluate(() =>
		fetch("/api/plugins", {
			headers: { authorization: "Bearer marketplace-detail-node-token" },
		}).then((response) => response.json())
	);
	expect(installed).toEqual({
		plugins: [{ id: "com.example.review-kit", installed: true }],
	});
	expect(
		fixture.requests
			.filter((request) => request.path === "/api/plugins/catalog/install")
			.map((request) => ({
				body: request.body,
				authorization: request.authorization,
				status: request.status,
			}))
	).toEqual([
		{
			body: { id: "com.example.review-kit" },
			authorization: "Bearer marketplace-detail-node-token",
			status: 403,
		},
		{
			body: { id: "com.example.review-kit" },
			authorization: "Bearer marketplace-detail-node-token",
			status: 200,
		},
	]);
});

test("initial review read failure reports recovery and disables authoring until the existing review is resolved", async ({
	page,
}) => {
	const fixture = await install(page, { ownReview: true });
	fixture.fail(
		"GET",
		`/api/marketplace/reviews?kind=bundle&id=${listingId}&limit=20`
	);
	await open(page);
	await more(page);
	await expect(page.getByRole("alert")).toContainText("Couldn't load reviews");
	await expect(
		page.getByRole("textbox", { name: "Review title" })
	).toBeDisabled();
	await expect(
		page.getByText("No reviews yet. Be the first to review this item.", {
			exact: true,
		})
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Retry reviews", exact: true })
		.click();
	await expect(page.getByRole("textbox", { name: "Review title" })).toHaveValue(
		"Existing review"
	);
	await expect(
		page.getByRole("button", { name: "Update review", exact: true })
	).toBeEnabled();
	await expect(page.getByRole("alert")).toHaveCount(0);
});
