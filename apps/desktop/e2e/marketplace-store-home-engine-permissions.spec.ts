// Marketplace Store home proof. Engine permission denials and pending installs.

import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	EVIDENCE_DIR,
	IDS,
	type RequestRecord,
} from "./marketplace-store-home.fixture.ts";
import {
	callsFor,
	deferred,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";

registerStoreHomeEvidenceHooks();

test("Engine permission denials preserve install and active state before exact retry readback", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	const denied: RequestRecord[] = [];
	const denyNext = async (path: string) => {
		await page.route(`**${path}`, async (route) => {
			if (route.request().method() !== "POST") {
				await route.fallback();
				return;
			}
			await page.unroute(`**${path}`);
			expect(route.request().headers().authorization).toBe(
				"Bearer fixture-node-token"
			);
			denied.push({
				method: "POST",
				path,
				search: "",
				body: route.request().postDataJSON(),
			});
			await route.fulfill({
				status: 403,
				contentType: "application/json",
				body: JSON.stringify({ error: "Engine action denied by policy" }),
			});
		});
	};
	const card = page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.locator("xpath=..");
	await denyNext(`/api/setup/${IDS.engineNew}/install`);
	await card.getByRole("button", { name: "Get", exact: true }).click();
	await expect(card.getByRole("alert")).toContainText("denied by policy");
	expect(fixture.engineInstalled.has(IDS.engineNew)).toBe(false);
	await card.getByRole("button", { name: "Get", exact: true }).click();
	await expect(card.getByRole("button", { name: "Installed" })).toBeVisible();
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	const activeSwitch = page.getByRole("switch", {
		name: "Set KoboldCPP Fixture as active engine",
	});
	await denyNext("/api/engine/active");
	await activeSwitch.click();
	await expect(
		page
			.getByRole("dialog")
			.getByText("/api/engine/active failed: 403", { exact: true })
	).toBeVisible();
	expect(fixture.engineActive).toBe(IDS.engineActive);
	await expect(activeSwitch).not.toBeChecked();
	await activeSwitch.click();
	await expect(activeSwitch).toBeChecked();
	expect(denied).toEqual([
		{
			method: "POST",
			path: `/api/setup/${IDS.engineNew}/install`,
			search: "",
			body: null,
		},
		{
			method: "POST",
			path: "/api/engine/active",
			search: "",
			body: { name: IDS.engineNew },
		},
	]);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).map(
			(call) => call.body
		)
	).toEqual([null]);
	expect(
		callsFor(fixture, "POST", "/api/engine/active").map((call) => call.body)
	).toEqual([{ name: IDS.engineNew }]);
	await page.reload();
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	await expect(
		page.getByRole("switch", { name: "Set KoboldCPP Fixture as active engine" })
	).toBeChecked();
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-policy-retry-readback.png"
		),
	});
});

test("Engine pending install withholds card context mutations until exact readback", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	const gate = deferred();
	fixture.engineActionGates[`${IDS.engineNew}:install`] = gate;
	const engine = page.getByRole("button", { name: "KoboldCPP Fixture" });
	const card = engine.locator("xpath=..");
	await card.getByRole("button", { name: "Get", exact: true }).click();
	await expect
		.poll(
			() =>
				callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).length
		)
		.toBe(1);
	await engine.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Get", exact: true })
	).toHaveCount(0);
	expect(fixture.engineInstalled.has(IDS.engineNew)).toBe(false);
	await page.keyboard.press("Escape");
	gate.release();
	await expect(card.getByRole("button", { name: "Installed" })).toBeVisible();
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).map(
			(call) => call.body
		)
	).toEqual([null]);
	await page.reload();
	await expect(
		page
			.getByRole("button", { name: "KoboldCPP Fixture" })
			.locator("xpath=..")
			.getByRole("button", { name: "Installed" })
	).toBeVisible();
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-pending-install-readback.png"
		),
	});
});
