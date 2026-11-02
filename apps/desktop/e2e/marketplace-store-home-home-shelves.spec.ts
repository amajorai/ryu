// Marketplace Store home proof. Home shelves: Add, like, Get, global results and See all.

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
	confirmSkillSetChange,
	deferred,
	openHome,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";
import { installLocalFixture } from "./marketplace-store-home.routes.ts";

registerStoreHomeEvidenceHooks();

test("every Home shelf Add and like uses its realm request and reads state back", async ({
	page,
}) => {
	const fixture = await openHome(page);
	fixture.installFailures["/api/models/catalog/install"] = 1;
	const modelsShelf = page
		.locator('[data-slot="marketplace-home-shelf"]')
		.filter({ hasText: "Popular models" });
	const modelCard = modelsShelf
		.getByRole("button", { name: "Home GGUF Candidate" })
		.locator("xpath=..");
	const modelAction = modelCard.locator('button[data-slot="button"]');
	await modelAction.click();
	await expect(modelAction).toHaveText("Add");
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/models/catalog/install").length)
		.toBe(1);
	const gate = deferred();
	fixture.installGate = gate;
	await modelAction.click();
	await expect(modelAction).toHaveText("Installing…");
	expect(modelAction).toBeDisabled();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/models/catalog/install").length)
		.toBe(2);
	gate.release();
	await expect(modelAction).toHaveText("Added");
	expect(modelAction).toBeDisabled();
	const modelInstalls = callsFor(
		fixture,
		"POST",
		"/api/models/catalog/install"
	);
	expect(modelInstalls.map((call) => call.body)).toEqual([
		{ id: IDS.model, file: "home-gemma-Q4_K_M.gguf", format: "gguf" },
		{ id: IDS.model, file: "home-gemma-Q4_K_M.gguf", format: "gguf" },
	]);
	const detailCalls = callsFor(fixture, "GET", "/api/models/catalog/detail");
	expect(detailCalls).toHaveLength(2);
	expect(
		detailCalls.map((call) => new URLSearchParams(call.search).get("id"))
	).toEqual([IDS.model, IDS.model]);
	for (const snapshot of [
		{
			format: "safetensors",
			id: "fixture/home-safetensors",
			name: "Home Safetensors Snapshot",
		},
		{ format: "mlx", id: "fixture/home-mlx", name: "Home MLX Snapshot" },
	]) {
		const card = modelsShelf
			.getByRole("button", { name: snapshot.name })
			.locator("xpath=..");
		const action = card.locator('button[data-slot="button"]');
		await action.click();
		await expect(action).toHaveText("Added");
		expect(
			callsFor(fixture, "POST", "/api/models/catalog/install").at(-1)?.body
		).toEqual({
			id: snapshot.id,
			format: snapshot.format,
		});
	}

	const shelfCases = [
		{
			name: "Home Skill Fixture",
			path: "/api/skills/catalog/install",
			body: {
				id: IDS.skill,
				promptForTargets: true,
				source: "fixture-skill-registry",
			},
		},
		{
			name: "Home MCP Fixture",
			path: "/api/mcp/catalog/install",
			body: { force: false, id: IDS.mcp },
		},
		{
			name: "Home Agent Fixture",
			path: "/api/agents/catalog/install",
			body: { id: IDS.agent },
		},
		{
			name: "Fixture Home App",
			path: `/api/plugins/${encodeURIComponent(IDS.app)}/install`,
			body: null,
		},
		{
			name: "Fixture Home Plugin",
			path: "/api/plugins/catalog/install",
			body: { id: IDS.plugin },
		},
	];
	for (const row of shelfCases) {
		const shelf = page
			.locator('[data-slot="marketplace-home-shelf"]')
			.filter({ hasText: row.name });
		const add = shelf.getByRole("button", { name: "Add" }).first();
		await add.click();
		if (row.path === "/api/skills/catalog/install") {
			await confirmSkillSetChange(page, fixture, row.path);
		}
		await expect(shelf.getByRole("button", { name: "Added" })).toBeDisabled();
		const write = callsFor(fixture, "POST", row.path).at(-1);
		expect(write?.body).toEqual(row.body);
	}

	const likeTargets = [
		{ id: IDS.model, name: "Home GGUF Candidate" },
		{ id: "fixture/home-safetensors", name: "Home Safetensors Snapshot" },
		{ id: "fixture/home-mlx", name: "Home MLX Snapshot" },
		{ id: IDS.recommendation, name: "For You Gemma" },
		{ id: IDS.skill, name: "Home Skill Fixture" },
		{ id: IDS.mcp, name: "Home MCP Fixture" },
		{ id: IDS.agent, name: "Home Agent Fixture" },
		{ id: IDS.contextAgent, name: "Context Agent Fixture" },
		{ id: IDS.app, name: "Fixture Home App" },
		{ id: IDS.plugin, name: "Fixture Home Plugin" },
	];
	for (const target of likeTargets) {
		const shelf = page
			.locator('[data-slot="marketplace-home-shelf"]')
			.filter({ hasText: target.name });
		const card = shelf
			.getByRole("button", { name: target.name })
			.locator("xpath=..");
		await card.getByRole("button", { name: "Like (2)" }).click();
		const unlike = card.getByRole("button", { name: "Unlike (3)" });
		await expect(unlike).toHaveAttribute("aria-pressed", "true");
		expect(
			callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
		).toEqual({
			namespace: target.id,
		});
		await unlike.click();
		const like = card.getByRole("button", { name: "Like (2)" });
		await expect(like).toHaveAttribute("aria-pressed", "false");
		expect(
			callsFor(fixture, "DELETE", "/api/marketplace/likes").at(-1)?.body
		).toEqual({
			namespace: target.id,
		});
		expect(fixture.likes[target.id]).toEqual({ count: 2, liked: false });
	}

	const finalLike = page
		.locator('[data-slot="marketplace-home-shelf"]')
		.filter({ hasText: "Fixture Home Plugin" })
		.getByTestId("item-like-button");
	await expect(finalLike).not.toHaveClass(/is-bursting/);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-home-shelves-added.png"),
	});
});

test("the shelf Get context action installs the selected item and reads it back", async ({
	page,
}) => {
	const fixture = await openHome(page);
	const agentsShelf = page
		.locator('[data-slot="marketplace-home-shelf"]')
		.filter({ hasText: "Context Agent Fixture" });
	await agentsShelf
		.getByRole("button", { name: "Context Agent Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Get" }).click();
	await expect(agentsShelf.getByRole("button", { name: "Added" })).toHaveCount(
		1
	);
	expect(
		callsFor(fixture, "POST", "/api/agents/catalog/install").at(-1)?.body
	).toEqual({
		id: IDS.contextAgent,
	});
});

test("global result heading carries the query to a realm and empty-state clear restores the selected realm", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	await page.goto(STORY_URL);
	const globalSearch = page.getByRole("searchbox", {
		name: "Search the whole marketplace…",
	});
	await globalSearch.fill("Heading Needle");
	await expect(
		page.getByRole("button", { name: "Heading Needle Model" })
	).toBeVisible();
	await page.getByRole("button", { name: /^Models\s+1$/ }).click();
	await expect(page.getByRole("tab", { name: "Models" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(globalSearch).toHaveValue("");
	const localSearch = page.getByRole("textbox", {
		name: /Search by name, org, tag, or type/,
	});
	await expect(localSearch).toHaveValue("Heading Needle");
	await expect(
		page.getByRole("button", { name: "Heading Needle Model" })
	).toBeVisible();
	const matchingModelRequest = fixture.calls.find(
		(call) =>
			call.method === "GET" &&
			call.path === "/api/models/catalog" &&
			new URLSearchParams(call.search).get("query") === "Heading Needle"
	);
	expect(matchingModelRequest).toBeDefined();

	await page.getByRole("tab", { name: "Agents" }).click();
	await globalSearch.fill("no-such-fixture-item");
	await expect(page.getByText("Nothing found")).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).last().click();
	await expect(globalSearch).toHaveValue("");
	await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		page.getByRole("button", { name: "Home Agent Fixture" })
	).toBeVisible();
});

test("See all on every shelf opens its matching catalog section", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const destinations = [
		{ section: "Featured skills", tab: "Skills" },
		{ section: "Popular models", tab: "Models" },
		{ section: "MCP servers", tab: "MCP" },
		// The agents realm is labelled "Coding agents" in the section strip.
		{ section: "Agents", tab: "Coding agents" },
		{ section: "Apps", tab: "Apps" },
		{ section: "Plugins", tab: "Plugins" },
	];
	for (const [index, destination] of destinations.entries()) {
		if (index === 0) {
			await openHome(page);
		} else {
			await page.goto(STORY_URL);
			await expect(
				page.getByRole("heading", { name: "For you" })
			).toBeVisible();
		}
		const shelf = page
			.locator('[data-slot="marketplace-home-shelf"]')
			.filter({ hasText: destination.section });
		await expect(shelf).toHaveCount(1);
		await shelf.getByRole("button", { name: "Open section" }).click();
		const selectedTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [data-slot="tabs-trigger"][data-active]'
		);
		await expect(selectedTab).toContainText(destination.tab);
		const selectedAccessibleTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [role="tab"][aria-selected="true"]'
		);
		await expect(selectedAccessibleTab).toHaveCount(1);
		await expect(selectedAccessibleTab).toContainText(destination.tab);
		await expect(page.locator("body")).not.toHaveText("");
		if (destination.section === "Featured skills") {
			await expect(
				page.getByRole("button", { name: "Search", exact: true })
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: /Home Skill Fixture/ })
			).toBeVisible();
			const modelsTab = page
				.locator(
					'[data-slot="store-section-tabs-scroller"] [data-slot="tabs-trigger"]'
				)
				.filter({ hasText: "Models" });
			expect(
				await modelsTab.evaluate((element) => element.matches(":focus"))
			).toBe(false);
			mkdirSync(EVIDENCE_DIR, { recursive: true });
			await prepareEvidenceCapture(page);
			await page.screenshot({
				path: resolve(EVIDENCE_DIR, "marketplace-store-home-see-all.png"),
			});
		}
	}
	expect(pageErrors).toEqual([]);
});
