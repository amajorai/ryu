// Marketplace Store home proof. Plugins reviews, community Get and card likes.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { EVIDENCE_DIR, IDS } from "./marketplace-store-home.fixture.ts";
import {
	callsFor,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";
import { storeEffectsSchema } from "./marketplace-store-home-proof.contracts.ts";

registerStoreHomeEvidenceHooks();

test("Plugins reviews validate, retry create and update, cancel edits, and delete with readback", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await details.getByRole("tab", { name: "Reviews" }).click();
	await expect(details.getByText("No reviews yet")).toBeVisible();
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/marketplace/reviews").length)
		.toBeGreaterThan(0);
	const firstReviewRead = callsFor(
		fixture,
		"GET",
		"/api/marketplace/reviews"
	).at(-1);
	expect(new URLSearchParams(firstReviewRead?.search).get("id")).toBe(
		IDS.plugin
	);
	expect(new URLSearchParams(firstReviewRead?.search).get("kind")).toBe(
		"plugin"
	);
	expect(new URLSearchParams(firstReviewRead?.search).get("limit")).toBe("20");

	await details.getByRole("button", { name: "Write the first review" }).click();
	const post = details.getByRole("button", { name: "Post review" });
	await post.click();
	await expect(details.getByText("Pick a star rating first.")).toBeVisible();
	const rating = details.getByRole("radiogroup", { name: "Rating" });
	await rating.getByRole("button", { name: "5 stars" }).click();
	const title = details.getByLabel("Title (optional)");
	const body = details.getByLabel("Review (optional)");
	await title.fill("Fixture review title");
	await body.fill("Fixture review body");
	fixture.reviewWriteFailures = 1;
	await post.click();
	await expect(
		details.getByText("Fixture review write unavailable")
	).toBeVisible();
	await expect(title).toHaveValue("Fixture review title");
	await expect(body).toHaveValue("Fixture review body");
	await post.click();
	await expect(details.getByText("Your review", { exact: true })).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/marketplace/reviews").map(
			(call) => call.body
		)
	).toEqual([
		{
			body: "Fixture review body",
			id: IDS.plugin,
			kind: "plugin",
			rating: 5,
			title: "Fixture review title",
		},
		{
			body: "Fixture review body",
			id: IDS.plugin,
			kind: "plugin",
			rating: 5,
			title: "Fixture review title",
		},
	]);
	expect(fixture.review).toMatchObject({
		body: "Fixture review body",
		rating: 5,
		title: "Fixture review title",
	});

	await title.fill("Unsubmitted title");
	await body.fill("Unsubmitted body");
	await rating.getByRole("button", { name: "2 stars" }).click();
	await details.getByRole("button", { name: "Cancel" }).click();
	await expect(title).toHaveValue("Fixture review title");
	await expect(body).toHaveValue("Fixture review body");
	await expect(rating.getByRole("button", { name: "5 stars" })).toHaveAttribute(
		"aria-checked",
		"true"
	);
	expect(callsFor(fixture, "POST", "/api/marketplace/reviews")).toHaveLength(2);

	await title.fill("Updated fixture title");
	await body.fill("Updated fixture body");
	await rating.getByRole("button", { name: "4 stars" }).click();
	fixture.reviewWriteFailures = 1;
	await details.getByRole("button", { name: "Update review" }).click();
	await expect(
		details.getByText("Fixture review write unavailable")
	).toBeVisible();
	await details.getByRole("button", { name: "Update review" }).click();
	await expect(title).toHaveValue("Updated fixture title");
	expect(fixture.review).toMatchObject({
		body: "Updated fixture body",
		rating: 4,
		title: "Updated fixture title",
	});
	expect(
		callsFor(fixture, "POST", "/api/marketplace/reviews")
			.slice(-2)
			.map((call) => call.body)
	).toEqual([
		{
			body: "Updated fixture body",
			id: IDS.plugin,
			kind: "plugin",
			rating: 4,
			title: "Updated fixture title",
		},
		{
			body: "Updated fixture body",
			id: IDS.plugin,
			kind: "plugin",
			rating: 4,
			title: "Updated fixture title",
		},
	]);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-plugin-review-readback.png"),
	});

	fixture.reviewDeleteFailures = 1;
	await details.getByRole("button", { name: "Delete" }).click();
	await expect(
		details.getByText("Fixture review delete unavailable")
	).toBeVisible();
	expect(fixture.review).not.toBeNull();
	await details.getByRole("button", { name: "Delete" }).click();
	await expect(details.getByText("No reviews yet")).toBeVisible();
	expect(fixture.review).toBeNull();
	const deletes = callsFor(fixture, "DELETE", "/api/marketplace/reviews");
	expect(deletes).toHaveLength(2);
	expect(new URLSearchParams(deletes[0]?.search).get("id")).toBe(IDS.plugin);
	expect(new URLSearchParams(deletes[0]?.search).get("kind")).toBe("plugin");
});

test("Plugins Reviews Load more follows the exact local cursor and appends the next page", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	fixture.reviewExtraRows = Array.from({ length: 21 }, (_, index) => {
		const itemIndex = index + 1;
		return {
			body: `Fixture review body ${itemIndex}.`,
			createdAt: "2026-08-20T00:00:00Z",
			id: `fixture-review-${itemIndex}`,
			mine: false,
			rating: 5,
			title: `Fixture review title ${itemIndex}`,
			userName: `Fixture Reviewer ${itemIndex}`,
			verifiedPurchase: false,
		};
	});
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await details.getByRole("tab", { name: "Reviews" }).click();
	await expect(
		details.getByText("Fixture review title 1", { exact: true })
	).toBeVisible();
	await expect(
		details.getByText("Fixture review title 20", { exact: true })
	).toBeVisible();
	await expect(
		details.getByText("Fixture review title 21", { exact: true })
	).toHaveCount(0);
	await details.getByRole("button", { name: "Load more reviews" }).click();
	await expect(
		details.getByText("Fixture review title 21", { exact: true })
	).toBeVisible();
	const reviewReads = callsFor(fixture, "GET", "/api/marketplace/reviews");
	const nextPageRead = reviewReads.at(-1);
	expect(new URLSearchParams(nextPageRead?.search).get("cursor")).toBe(
		"fixture-review-next"
	);
	expect(new URLSearchParams(nextPageRead?.search).get("id")).toBe(IDS.plugin);
	expect(new URLSearchParams(nextPageRead?.search).get("kind")).toBe("plugin");
	expect(new URLSearchParams(nextPageRead?.search).get("limit")).toBe("20");
});

test("Signed-out Reviews keeps reading available and captures Sign in to review handoff", async ({
	page,
}) => {
	await page.addInitScript(() => {
		window.localStorage.setItem(
			"fixture-marketplace-reviews-signed-out",
			"true"
		);
	});
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await details.getByRole("tab", { name: "Reviews" }).click();
	await expect(details.getByText("No reviews yet")).toBeVisible();
	await expect(
		details.getByText("Sign in to write the first review.")
	).toBeVisible();
	await details.getByRole("button", { name: "Sign in to review" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedExternalUrls;
		})
		.toEqual(["https://fixture.invalid/login"]);
	expect(callsFor(fixture, "POST", "/api/marketplace/reviews")).toHaveLength(0);
});

test("Community Plugin direct Get shows a retryable failure and persists URL-based install", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	fixture.appUrlInstallFailures = 1;
	const communityCard = page
		.getByRole("button", { name: "Community Fixture Plugin" })
		.locator("xpath=..");
	await expect(
		page.getByText("Not reviewed by Ryu", { exact: true })
	).toBeVisible();
	await communityCard.getByRole("button", { name: "Like (2)" }).click();
	await expect(
		communityCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	await communityCard.getByRole("button", { name: "Unlike (3)" }).click();
	await expect(
		communityCard.getByRole("button", { name: "Like (2)" })
	).toHaveAttribute("aria-pressed", "false");
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
	).toEqual({ namespace: IDS.communityPlugin });
	expect(
		callsFor(fixture, "DELETE", "/api/marketplace/likes").at(-1)?.body
	).toEqual({ namespace: IDS.communityPlugin });
	await page.getByRole("button", { name: "Read the trust guidance" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedExternalUrls;
		})
		.toEqual(["https://docs.ryuhq.com/docs/security/trust-model"]);
	await communityCard.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		page.getByText("Gateway unreachable (fail-closed): gateway unreachable", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		communityCard.getByRole("button", { name: "Get", exact: true })
	).toBeVisible();
	await communityCard.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		communityCard.getByRole("button", { name: "Installed", exact: true })
	).toBeDisabled();
	await expect(
		page.getByText("Not reviewed by Ryu", { exact: true })
	).toBeVisible();
	expect(fixture.appsInstalled.has(IDS.communityPlugin)).toBe(true);
	expect(
		callsFor(fixture, "POST", "/api/plugins/install").map((call) => call.body)
	).toEqual([
		{ url: "https://github.com/fixture/community-plugin" },
		{ url: "https://github.com/fixture/community-plugin" },
	]);
	await page.reload();
	const installedCommunityCard = page
		.getByRole("button", { name: "Community Fixture Plugin" })
		.locator("xpath=..");
	await expect(
		installedCommunityCard.getByRole("button", {
			name: "Installed",
			exact: true,
		})
	).toBeDisabled();
	await expect(
		installedCommunityCard.getByRole("button", { name: "Like (2)" })
	).toHaveAttribute("aria-pressed", "false");
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-community-plugin-installed.png"
		),
	});
});

test("Community preview Get installs from the selected repository URL", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Community Fixture Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Not reviewed by Ryu");
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/plugins/install").length)
		.toBe(1);
	expect(
		callsFor(fixture, "POST", "/api/plugins/install").at(-1)?.body
	).toEqual({
		url: "https://github.com/fixture/community-plugin",
	});
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install")
	).toHaveLength(0);
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(fixture.appsInstalled.has(IDS.communityPlugin)).toBe(true);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-community-preview-installed.png"
		),
	});
});

test("Plugins card likes persist and the right-click Get action retries the exact catalog install", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	const plugin = page.getByRole("button", { name: "Fixture Home Plugin" });
	const pluginCard = plugin.locator("xpath=..");
	await pluginCard.getByRole("button", { name: "Like (2)" }).click();
	await expect(
		pluginCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
	).toEqual({ namespace: IDS.plugin });
	const batchReadsBeforeReload = callsFor(
		fixture,
		"POST",
		"/api/marketplace/likes/batch"
	).length;
	await page.reload();
	const persistedCard = page
		.getByRole("button", { name: "Fixture Home Plugin" })
		.locator("xpath=..");
	await expect(
		persistedCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	// The likes store coalesces reads per 16ms window, so the first-party and
	// community shelves may land in separate batches in either order; the
	// persisted heart must come from a post-reload read that named this plugin.
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes/batch")
			.slice(batchReadsBeforeReload)
			.map((call) => call.body)
	).toContainEqual(
		expect.objectContaining({
			namespaces: expect.arrayContaining([IDS.plugin]),
		})
	);

	fixture.pluginInstallFailures = 1;
	await page
		.getByRole("button", { name: "Fixture Home Plugin" })
		.click({ button: "right" });
	const contextGet = page.getByRole("menuitem", { name: "Get" });
	await expect(contextGet).toBeVisible();
	await contextGet.click();
	const details = page.getByRole("dialog").first();
	await expect(
		details.getByText(
			"Gateway unreachable (fail-closed): gateway unreachable",
			{
				exact: true,
			}
		)
	).toBeVisible();
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install").map(
			(call) => call.body
		)
	).toEqual([{ id: IDS.plugin }, { id: IDS.plugin }]);
	expect(fixture.appsInstalled.has(IDS.plugin)).toBe(true);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-plugin-context-installed.png"
		),
	});
});
