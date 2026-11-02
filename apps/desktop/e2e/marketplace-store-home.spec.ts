// Marketplace Store home proof. Home: For you recommendations and shelf cards.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	EVIDENCE_DIR,
	IDS,
	STORY_URL,
} from "./marketplace-store-home.fixture.ts";
import {
	callsFor,
	openHome,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";

registerStoreHomeEvidenceHooks();

test("For you cadence, refresh, hide and re-enable persist through the Core fixture", async ({
	page,
}) => {
	const fixture = await openHome(page);
	const forYou = page
		.locator('[data-slot="marketplace-home"] > div > section')
		.first();
	const cadence = page.getByRole("combobox", {
		name: "Recommendation refresh cadence",
	});
	for (const value of ["daily", "monthly", "weekly"] as const) {
		await cadence.selectOption(value);
		await expect(cadence).toHaveValue(value);
		await expect
			.poll(() => callsFor(fixture, "PUT", "/api/gateway/config").length)
			.toBe(value === "daily" ? 1 : value === "monthly" ? 2 : 3);
		const write = callsFor(fixture, "PUT", "/api/gateway/config").at(-1);
		expect(write?.body).toEqual({
			marketplace_recommendations: { cadence: value, enabled: true },
		});
	}

	fixture.refreshFailures = 1;
	await page.getByRole("button", { name: "Refresh For you" }).click();
	await expect(
		forYou.getByRole("button", { name: "For You Gemma" })
	).toBeVisible();
	await expect
		.poll(
			() => callsFor(fixture, "POST", "/api/marketplace/recommendations").length
		)
		.toBe(1);
	await page.getByRole("button", { name: "Refresh For you" }).click();
	await expect(
		page.getByRole("button", { name: "Refreshed For You Gemma" })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/marketplace/recommendations").map(
			(call) => call.search
		)
	).toEqual(["?refresh=true", "?refresh=true"]);
	expect(
		callsFor(fixture, "POST", "/api/marketplace/recommendations").map(
			(call) => call.body
		)
	).toEqual([null, null]);

	await page.getByRole("button", { name: "Hide For you" }).click();
	await expect(
		page.getByRole("button", { name: "Re-enable For you" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Refreshed For You Gemma" })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Re-enable For you" }).click();
	await expect(
		page.getByRole("button", { name: "Refreshed For You Gemma" })
	).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/marketplace/recommendations/preference").map(
			(call) => call.body
		)
	).toEqual([{ hidden: true }, { hidden: false }]);

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Recommendation refresh cadence" })
	).toHaveValue("weekly");
	await expect(
		page.getByRole("button", { name: "Refreshed For You Gemma" })
	).toBeVisible();
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-home-recommendations.png"),
	});
});

test("every recommendation card opens its exact item in the matching realm", async ({
	page,
}) => {
	const fixture = await openHome(page);
	const destinations = [
		{
			item: "For You Gemma",
			tab: "Models",
			id: IDS.recommendation,
			path: "/api/models/catalog/detail",
		},
		{
			item: "For You Skill",
			tab: "Skills",
			id: IDS.recommendationSkill,
			path: "/api/skills/catalog/detail",
		},
		{
			item: "For You MCP",
			tab: "MCP",
			id: IDS.recommendationMcp,
			path: "/api/mcp/catalog/detail",
		},
		{
			item: "For You Agent",
			// The agents realm is labelled "Coding agents" in the section strip.
			tab: "Coding agents",
			id: IDS.recommendationAgent,
			path: null,
		},
		{
			item: "For You App",
			tab: "Apps",
			id: IDS.recommendationApp,
			path: "/api/plugins/catalog/detail",
		},
		{
			item: "For You Plugin",
			tab: "Plugins",
			id: IDS.recommendationPlugin,
			path: "/api/plugins/catalog/detail",
		},
	];
	for (const [index, destination] of destinations.entries()) {
		if (index > 0) {
			await page.goto(STORY_URL);
			await expect(
				page.getByRole("heading", { name: "For you" })
			).toBeVisible();
		}
		const forYou = page
			.locator('[data-slot="marketplace-home"] > div > section')
			.first();
		await forYou.getByRole("button", { name: destination.item }).click();
		const selectedTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [data-slot="tabs-trigger"][data-active]'
		);
		await expect(selectedTab).toContainText(destination.tab);
		const selectedAccessibleTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [role="tab"][aria-selected="true"]'
		);
		await expect(selectedAccessibleTab).toHaveCount(1);
		await expect(selectedAccessibleTab).toContainText(destination.tab);
		const detailPath = destination.path;
		if (detailPath) {
			await expect
				.poll(() => {
					const detailCall = callsFor(fixture, "GET", detailPath).at(-1);
					return new URLSearchParams(detailCall?.search).get("id");
				})
				.toBe(destination.id);
		} else {
			await expect(
				page.getByText("For You Agent", { exact: true }).first()
			).toBeVisible();
		}
	}
});

test("each Home shelf card selects its exact listing in the matching realm", async ({
	page,
}) => {
	const fixture = await openHome(page);
	const destinations = [
		{
			item: "Home GGUF Candidate",
			tab: "Models",
			id: IDS.model,
			path: "/api/models/catalog/detail",
		},
		{
			item: "Home Skill Fixture",
			tab: "Skills",
			id: IDS.skill,
			path: "/api/skills/catalog/detail",
		},
		{
			item: "Home MCP Fixture",
			tab: "MCP",
			id: IDS.mcp,
			path: "/api/mcp/catalog/detail",
		},
		{
			item: "Home Agent Fixture",
			// The agents realm is labelled "Coding agents" in the section strip.
			tab: "Coding agents",
			id: IDS.agent,
			path: null,
		},
		{
			item: "Fixture Home App",
			tab: "Apps",
			id: IDS.app,
			path: "/api/plugins/catalog/detail",
		},
		{
			item: "Fixture Home Plugin",
			tab: "Plugins",
			id: IDS.plugin,
			path: "/api/plugins/catalog/detail",
		},
	];
	for (const [index, destination] of destinations.entries()) {
		if (index > 0) {
			await page.goto(STORY_URL);
			await expect(
				page.getByRole("heading", { name: "For you" })
			).toBeVisible();
		}
		const shelf = page
			.locator('[data-slot="marketplace-home-shelf"]')
			.filter({ hasText: destination.item });
		await shelf.getByRole("button", { name: destination.item }).click();
		const selectedTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [data-slot="tabs-trigger"][data-active]'
		);
		await expect(selectedTab).toHaveCount(1);
		await expect(selectedTab).toContainText(destination.tab);
		const selectedAccessibleTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [role="tab"][aria-selected="true"]'
		);
		await expect(selectedAccessibleTab).toHaveCount(1);
		await expect(selectedAccessibleTab).toContainText(destination.tab);
		if (index === 0) {
			mkdirSync(EVIDENCE_DIR, { recursive: true });
			await prepareEvidenceCapture(page);
			await expect(
				page.getByText(/The total tokens the model can read/)
			).not.toBeVisible();
			await page.screenshot({
				path: resolve(
					EVIDENCE_DIR,
					"marketplace-store-home-card-navigation.png"
				),
			});
		}
		const detailPath = destination.path;
		if (detailPath) {
			if (index === 0) {
				await expect
					.poll(() => callsFor(fixture, "GET", detailPath).at(-1)?.search)
					.toContain("id");
			}
			await expect
				.poll(() => {
					const detailCall = callsFor(fixture, "GET", detailPath).at(-1);
					return new URLSearchParams(detailCall?.search).get("id");
				})
				.toBe(destination.id);
		} else {
			await expect(
				page.getByText("Home Agent Fixture", { exact: true }).first()
			).toBeVisible();
		}
	}
});
