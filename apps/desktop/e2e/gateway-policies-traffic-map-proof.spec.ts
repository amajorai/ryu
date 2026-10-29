// Renders the Gateway dialog's "Guardrail policies" and "Traffic map" sections
// in the desktop Vite proof harness against a mocked Core and control plane,
// with no `next/navigation` alias (the desktop graph builds without Next).
// Checks that every control used here is reachable and usable from the
// keyboard, that focus never falls back to the dialog when a page changes,
// and that the map's pulses stop under prefers-reduced-motion while the
// counts keep updating. Traffic rows are synthetic ids, layers and S-codes.

import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const HARNESS = "gateway-traffic-map-proof.html";

function evidencePath(name: string): string {
	const dir =
		process.env.RYU_PROOF_EVIDENCE_DIR ??
		path.join(tmpdir(), "ryu-gateway-policies-traffic-map-evidence");
	return path.join(dir, `${name}.png`);
}

async function isFocused(locator: Locator): Promise<boolean> {
	return await locator.evaluate(
		(element) => element === document.activeElement
	);
}

/** Press Tab until `target` holds focus, as a keyboard-only viewer would. */
async function tabTo(page: Page, target: Locator, limit = 200) {
	for (let step = 0; step < limit; step += 1) {
		if (await isFocused(target)) {
			return step;
		}
		await page.keyboard.press("Tab");
	}
	throw new Error(`not reachable with ${limit} Tab presses`);
}

/** Arrow through an open listbox to `name`, then pick it with Enter. */
async function chooseOption(page: Page, name: string, limit = 12) {
	const option = page.getByRole("option", { name, exact: true });
	await expect(option).toBeVisible();
	for (let step = 0; step < limit; step += 1) {
		// Base UI marks an item highlighted a frame before it moves DOM focus to
		// it; Enter only commits once the item itself holds focus.
		if ((await option.getAttribute("data-highlighted")) !== null) {
			await expect(option).toBeFocused();
			await page.keyboard.press("Enter");
			// Focus returns to the trigger once the list has finished closing.
			await expect(page.getByRole("listbox")).toHaveCount(0);
			return;
		}
		await page.keyboard.press("ArrowDown");
	}
	throw new Error(`option ${name} not reachable with the arrow keys`);
}

async function focusVisible(locator: Locator): Promise<boolean> {
	return await locator.evaluate((element) => element.matches(":focus-visible"));
}

async function pulseCount(page: Page): Promise<number> {
	return await page.locator("[data-traffic-map] animateMotion").count();
}

async function requestTotal(page: Page): Promise<number> {
	const text = await page
		.locator("[data-traffic-map]")
		.getByText(/requests/)
		.first()
		.innerText();
	const match = /(\d[\d,]*)\s+requests/.exec(text);
	return match ? Number(match[1].replaceAll(",", "")) : 0;
}

test.describe("Guardrail policies section", () => {
	test("renders and keeps keyboard focus across its pages", async ({
		page,
	}) => {
		await page.goto(`${HARNESS}?org=1&section=policies`);
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("Named policies")).toBeVisible({
			timeout: 30_000,
		});
		const row = dialog.getByRole("button", { name: /^Strict screening/ });
		await expect(row).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: /^Approved models only/ })
		).toBeVisible();
		await page.screenshot({
			animations: "disabled",
			path: evidencePath("desktop-guardrail-policies-index"),
		});

		await dialog.focus();
		await tabTo(page, row);
		expect(await focusVisible(row)).toBe(true);

		await page.keyboard.press("Enter");
		const heading = dialog.getByRole("heading", { name: "Strict screening" });
		await expect(heading).toBeFocused();
		await expect(dialog.getByLabel("Name")).toHaveValue("Strict screening");
		await page.screenshot({
			animations: "disabled",
			path: evidencePath("desktop-guardrail-policies-editor"),
		});

		await page.keyboard.press("Shift+Tab");
		const back = dialog.getByRole("button", { name: "Policies", exact: true });
		await expect(back).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(row).toBeFocused();

		const effective = dialog.getByRole("button", { name: /Effective policy/ });
		await tabTo(page, effective, 10);
		await page.keyboard.press("Enter");
		await expect(
			dialog.getByRole("heading", { name: "Effective policy" })
		).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Enter");
		await expect(effective).toBeFocused();
	});
});

test.describe("Traffic map section", () => {
	test("draws live pulses and assigns a policy from the keyboard", async ({
		page,
	}) => {
		await page.goto(`${HARNESS}?org=1&rate=50`);
		const map = page.locator("[data-traffic-map]");
		await expect(
			map.getByRole("button", { name: /^This gateway, Gateway/ })
		).toBeVisible({ timeout: 30_000 });
		await expect
			.poll(() => pulseCount(page), { timeout: 10_000 })
			.toBeGreaterThan(0);
		await page.screenshot({
			animations: "disabled",
			path: evidencePath("desktop-traffic-map-live"),
		});

		const chip = map.getByRole("button", { name: "Assign Strict screening" });
		await page.getByRole("dialog").focus();
		await tabTo(page, chip);
		expect(await focusVisible(chip)).toBe(true);
		await page.keyboard.press("Enter");

		const assign = page.getByRole("dialog", {
			name: "Assign Strict screening",
		});
		await expect(assign).toBeVisible();
		const layer = assign.getByRole("combobox", { name: "Layer" });
		await tabTo(page, layer, 10);
		await page.keyboard.press("Enter");
		await chooseOption(page, "Teams");
		await expect(layer).toHaveText(/Teams/);
		const scope = assign.getByRole("combobox", { name: "Scope" });
		await tabTo(page, scope, 10);
		await page.keyboard.press("Enter");
		await chooseOption(page, "Platform");
		await expect(scope).toHaveText(/Platform/);
		await page.screenshot({
			animations: "disabled",
			path: evidencePath("desktop-traffic-map-assign-keyboard"),
		});
		const submit = assign.getByRole("button", { name: "Assign", exact: true });
		await tabTo(page, submit, 10);
		await page.keyboard.press("Enter");
		await expect(assign).toBeHidden();
		await expect(map.getByRole("status")).toContainText("Strict screening");

		const sent = await page.evaluate(() =>
			Reflect.get(Reflect.get(window, "__trafficMapProof"), "assignRequests")
		);
		expect(sent).toEqual([
			{ policyId: "pol_strict", scope: { id: "team_platform", kind: "team" } },
		]);
	});

	test("opens the larger map from the keyboard and returns focus", async ({
		page,
	}) => {
		await page.goto(`${HARNESS}?org=1&rate=20`);
		const expand = page.getByRole("button", { name: "Expand map" });
		await expect(expand).toBeVisible({ timeout: 30_000 });
		await page.getByRole("dialog").focus();
		await tabTo(page, expand);
		expect(await focusVisible(expand)).toBe(true);
		await page.keyboard.press("Enter");
		const large = page.getByRole("dialog", { name: "Traffic map" });
		await expect(large).toBeVisible();
		await expect(
			large.getByRole("button", { name: "Shrink map" })
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(large).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Expand map" })
		).toBeFocused();
	});

	test("stops pulses under reduced motion and keeps counting", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.goto(`${HARNESS}?org=1&rate=50`);
		const map = page.locator("[data-traffic-map]");
		await expect(
			map.getByRole("button", { name: /^This gateway, Gateway/ })
		).toBeVisible({ timeout: 30_000 });
		await expect
			.poll(() => requestTotal(page), { timeout: 10_000 })
			.toBeGreaterThan(0);
		const before = await requestTotal(page);
		await page.waitForTimeout(2000);
		expect(await requestTotal(page)).toBeGreaterThan(before);
		expect(await pulseCount(page)).toBe(0);
		await page.screenshot({
			animations: "disabled",
			path: evidencePath("desktop-traffic-map-reduced-motion"),
		});
	});
});
