import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	openSettings,
	openStory,
	result,
	revealState,
	row,
	searchBox,
	sectionHeading,
	settingsDialog,
} from "./unswept-b-settings.support.ts";

// Settings search → navigation → reveal against the unswept-b story
// (production `LazySettingsDialog` + `LazyGatewayDialog`, store-driven like
// NavUser, local API fixtures, the app's Toaster). Keyboard operation, the
// lazy entry point and the dialog's own controls are in
// `unswept-b-settings-dialog.spec.ts`.

test("a same-dialog result switches to its section, opens the sub-page that holds the row, clears the search, restores the nav, and flashes the row in view", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);
	const search = searchBox(dialog);

	await search.fill("Open chats at the latest message");
	const hit = result(dialog, "Open chats at the latest message");
	await expect(hit).toBeVisible();
	// While searching, the nav is replaced by results.
	await expect(
		dialog.getByRole("button", { name: "Billing", exact: true })
	).toHaveCount(0);

	await hit.click();
	await expect(sectionHeading(dialog)).toHaveText("Appearance");
	await expect(search).toHaveValue("");
	await expect(
		dialog.getByRole("button", { name: "Billing", exact: true })
	).toBeVisible();
	const target = row(dialog, "Open chats at the latest message");
	await expect(target).toBeVisible();
	const state = await revealState(target);
	expect(state.animated).toBe(true);
	expect(state.inView).toBe(true);
	expect(errors).toEqual([]);
});

test("a row hidden behind a disclosure still lands on its section without an error", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);
	await searchBox(dialog).fill("Wipe this data folder");
	await result(dialog, "Wipe this data folder at midnight").click();
	await expect(sectionHeading(dialog)).toHaveText("Developer");
	// The daily reset lives behind Developer Mode, which is off.
	await expect(row(dialog, "Wipe this data folder at midnight")).toHaveCount(0);
	await expect(row(dialog, "Enable developer mode")).toBeVisible();
	await expect(searchBox(dialog)).toHaveValue("");
	expect(errors).toEqual([]);
});

test("a result that lives in the Gateway dialog closes Settings first, opens the Gateway dialog on that section, and reveals the row there", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);
	await searchBox(dialog).fill("Enable smart routing");
	const hit = result(dialog, "Enable smart routing");
	await expect(hit).toBeVisible();
	await expect(
		dialog.getByText("Model routing · Node", { exact: true })
	).toBeVisible();

	await hit.click();
	await expect(page.getByTestId("settings-open-state")).toHaveText("closed");
	await expect(page.getByTestId("gateway-state")).toHaveText("open:routing");
	expect(await page.evaluate(() => window.__unsweptBOpenChanges)).toEqual([
		false,
	]);
	const gateway = settingsDialog(page);
	await expect(sectionHeading(gateway)).toHaveText("Model routing", {
		timeout: 60_000,
	});
	// Only one modal: the Settings dialog is gone before the Gateway one shows.
	await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(1);
	const target = row(gateway, "Enable smart routing");
	await expect(target).toBeVisible();
	const state = await revealState(target);
	expect(state.animated).toBe(true);
	expect(state.inView).toBe(true);
	expect(errors).toEqual([]);
});

async function gatewayFromSettings(page: Page, dialog: Locator) {
	await dialog
		.getByRole("button", { name: /^(Gateway|Device) settings$/ })
		.click();
	await expect(page.getByTestId("settings-open-state")).toHaveText("closed");
	const gateway = settingsDialog(page);
	await expect(sectionHeading(gateway)).toHaveText("Overview", {
		timeout: 60_000,
	});
	return gateway;
}

test("a Gateway search result for a row on a Settings sub-page reopens Settings on that sub-page and flashes the row", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const settings = await openSettings(page);
	const gateway = await gatewayFromSettings(page, settings);
	await searchBox(gateway).fill("Sticky folders");
	await expect(
		gateway.getByText("Appearance · App", { exact: true })
	).toBeVisible();
	await result(gateway, "Sticky folders").click();

	await expect(page.getByTestId("gateway-state")).toHaveText("closed");
	await expect(page.getByTestId("settings-open-state")).toHaveText("open");
	const reopened = settingsDialog(page);
	await expect(sectionHeading(reopened)).toHaveText("Appearance");
	const target = row(reopened, "Sticky folders");
	await expect(target).toBeVisible();
	expect((await revealState(target)).animated).toBe(true);
	await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(1);
	expect(errors).toEqual([]);
});

test("reopening Settings on the section it already showed still opens the sub-page and flashes the requested row", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const settings = await openSettings(page);
	await settings
		.getByRole("button", { name: "Appearance", exact: true })
		.click();
	await expect(sectionHeading(settings)).toHaveText("Appearance");
	const gateway = await gatewayFromSettings(page, settings);
	await searchBox(gateway).fill("Sticky folders");
	await result(gateway, "Sticky folders").click();

	const reopened = settingsDialog(page);
	await expect(sectionHeading(reopened)).toHaveText("Appearance");
	const target = row(reopened, "Sticky folders");
	await expect(target).toBeVisible();
	expect((await revealState(target)).animated).toBe(true);
	expect(errors).toEqual([]);
});

/** Wait until no highlight animation is running on `target`. */
async function flashEnded(target: Locator) {
	await expect
		.poll(() => target.evaluate((element) => element.getAnimations().length), {
			timeout: 10_000,
		})
		.toBe(0);
}

/**
 * Count the highlight flashes started on rows titled `title` from now on. The
 * flash is counted when its animation starts, so a highlight that has already
 * ended by the time the test looks (it lasts 1.6 s) is still seen. Returns a
 * reader for the count.
 */
async function countFlashes(page: Page, title: string) {
	await page.evaluate((label) => {
		const counts = window.__unsweptBFlashes ?? {};
		counts[label] = 0;
		window.__unsweptBFlashes = counts;
		if (window.__unsweptBAnimate) {
			return;
		}
		const original = Element.prototype.animate;
		window.__unsweptBAnimate = original;
		Element.prototype.animate = function animate(
			this: Element,
			...args: Parameters<Element["animate"]>
		) {
			const heading = this.matches('[data-slot="item-title"]')
				? this
				: this.querySelector('[data-slot="item-title"]');
			const text = (heading?.textContent ?? "").replace(/\s+/g, " ").trim();
			const seen = window.__unsweptBFlashes ?? {};
			if (text in seen) {
				seen[text] = (seen[text] ?? 0) + 1;
			}
			return original.apply(this, args);
		};
	}, title);
	return () =>
		page.evaluate((label) => window.__unsweptBFlashes?.[label] ?? 0, title);
}

/** Search `dialog` for `label` and choose that result. */
async function chooseResult(dialog: Locator, label: string) {
	await searchBox(dialog).fill(label);
	await result(dialog, label).click();
	await expect(searchBox(dialog)).toHaveValue("");
}

test("a result for the row already open is revealed again from the section that shows it", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);

	await chooseResult(dialog, "Open chats at the latest message");
	await expect(sectionHeading(dialog)).toHaveText("Appearance");
	const target = row(dialog, "Open chats at the latest message");
	await expect(target).toBeVisible();
	expect((await revealState(target)).animated).toBe(true);
	await flashEnded(target);

	const flashes = await countFlashes(page, "Open chats at the latest message");
	await chooseResult(dialog, "Open chats at the latest message");
	await expect(sectionHeading(dialog)).toHaveText("Appearance");
	await expect(target).toBeVisible();
	await expect.poll(flashes).toBe(1);
	expect((await revealState(target)).inView).toBe(true);
	expect(errors).toEqual([]);
});

test("a result on another sub-page of the section already open opens that page and highlights the row, leaving nothing pending", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);

	await chooseResult(dialog, "Open chats at the latest message");
	await expect(sectionHeading(dialog)).toHaveText("Appearance");
	const first = row(dialog, "Open chats at the latest message");
	await expect(first).toBeVisible();
	await flashEnded(first);

	const flashes = await countFlashes(page, "Sticky folders");
	await chooseResult(dialog, "Sticky folders");
	await expect(sectionHeading(dialog)).toHaveText("Appearance");
	const other = row(dialog, "Sticky folders");
	await expect(other).toBeVisible();
	await expect.poll(flashes).toBe(1);
	expect((await revealState(other)).inView).toBe(true);
	await flashEnded(other);

	// The request was claimed: leaving Appearance and coming back flashes no row.
	await dialog.getByRole("button", { name: "General", exact: true }).click();
	await expect(sectionHeading(dialog)).toHaveText("General");
	await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
	await expect(sectionHeading(dialog)).toHaveText("Appearance");
	await expect(dialog.locator('[data-slot="item"]').first()).toBeVisible();
	const flashing = await dialog.evaluate(async (element) => {
		for (let frame = 0; frame < 30; frame += 1) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		return [...element.querySelectorAll('[data-slot="item"]')].filter(
			(item) => item.getAnimations().length > 0
		).length;
	});
	expect(flashing).toBe(0);
	expect(errors).toEqual([]);
});

/** From Settings, search for a Gateway row and land on it. */
async function gatewayRowFromSettings(page: Page, label: string) {
	const settings = await openSettings(page);
	await chooseResult(settings, label);
	await expect(page.getByTestId("settings-open-state")).toHaveText("closed");
	return settingsDialog(page);
}

test("Gateway settings reveal a result in the section already open", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const gateway = await gatewayRowFromSettings(page, "Enable smart routing");
	await expect(page.getByTestId("gateway-state")).toHaveText("open:routing");
	await expect(sectionHeading(gateway)).toHaveText("Model routing", {
		timeout: 60_000,
	});
	const target = row(gateway, "Enable smart routing");
	await expect(target).toBeVisible();
	expect((await revealState(target)).animated).toBe(true);
	await flashEnded(target);

	const flashes = await countFlashes(page, "Enable smart routing");
	await chooseResult(gateway, "Enable smart routing");
	await expect(sectionHeading(gateway)).toHaveText("Model routing");
	await expect.poll(flashes).toBe(1);
	expect((await revealState(target)).inView).toBe(true);
	expect(errors).toEqual([]);
});

test("Gateway settings reopened on the section they last showed still reveal the requested row", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const gateway = await gatewayRowFromSettings(page, "Enable smart routing");
	await expect(sectionHeading(gateway)).toHaveText("Model routing", {
		timeout: 60_000,
	});
	const target = row(gateway, "Enable smart routing");
	await expect(target).toBeVisible();
	await flashEnded(target);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("gateway-state")).toHaveText("closed");

	const flashes = await countFlashes(page, "Enable smart routing");
	const reopened = await gatewayRowFromSettings(page, "Enable smart routing");
	await expect(page.getByTestId("gateway-state")).toHaveText("open:routing");
	await expect(sectionHeading(reopened)).toHaveText("Model routing");
	const reopenedRow = row(reopened, "Enable smart routing");
	await expect(reopenedRow).toBeVisible();
	await expect.poll(flashes).toBe(1);
	expect(errors).toEqual([]);
});

test("a Settings result in a sub-paged Gateway section opens that sub-page and highlights the row", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const flashes = await countFlashes(page, "Share anonymous usage analytics");
	const gateway = await gatewayRowFromSettings(
		page,
		"Share anonymous usage analytics"
	);
	await expect(page.getByTestId("gateway-state")).toHaveText("open:privacy");
	const target = row(gateway, "Share anonymous usage analytics");
	await expect(target).toBeVisible({ timeout: 60_000 });
	await expect.poll(flashes).toBe(1);
	expect((await revealState(target)).inView).toBe(true);
	expect(errors).toEqual([]);
});

/**
 * Record, from now on, which dialog was open each time a row titled `title`
 * started its highlight: "gateway" while the Gateway dialog is open, else
 * "settings". Returns a reader for the log.
 */
async function flashLog(page: Page, title: string) {
	await page.evaluate((label) => {
		window.__unsweptBFlashLog = [];
		const original = Element.prototype.animate;
		Element.prototype.animate = function animate(
			this: Element,
			...args: Parameters<Element["animate"]>
		) {
			const heading = this.matches('[data-slot="item-title"]')
				? this
				: this.querySelector('[data-slot="item-title"]');
			const text = (heading?.textContent ?? "").replace(/\s+/g, " ").trim();
			if (text === label) {
				const gateway =
					document.querySelector('[data-testid="gateway-state"]')
						?.textContent ?? "";
				window.__unsweptBFlashLog?.push(
					gateway.startsWith("open") ? "gateway" : "settings"
				);
			}
			return original.apply(this, args);
		};
	}, title);
	return () => page.evaluate(() => [...(window.__unsweptBFlashLog ?? [])]);
}

test("a Settings pane that opens on a section while the Gateway's request for the same section id is pending leaves the request to the Gateway pane", async ({
	page,
}) => {
	const errors: string[] = [];
	// Hold the Gateway dialog's code so its request stays pending.
	let release: (() => Promise<void>) | undefined;
	await page.route("**/gateway/GatewayDialog.tsx*", async (route) => {
		await new Promise<void>((resolve) => {
			release = async () => {
				await route.continue();
				resolve();
			};
		});
	});
	await openStory(page, errors);
	const flashes = await flashLog(page, "Channel");
	const settings = await openSettings(page);

	// "Channel" is a Gateway row in the node's Updates section. Choosing it
	// closes Settings and asks the Gateway dialog for section "updates", whose
	// code is still loading; the user closes the loading dialog.
	await searchBox(settings).fill("Channel");
	await result(settings, "Channel").click();
	await expect(page.getByTestId("settings-open-state")).toHaveText("closed");
	await expect(page.getByTestId("gateway-state")).toHaveText("open:updates");
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("gateway-state")).toHaveText("closed");

	// Settings has an "updates" section too, with its own Channel row. Its pane
	// mounts while the Gateway's request for "updates" is pending, and must not
	// take it: nothing in Settings is highlighted.
	const reopened = await openSettings(page);
	await reopened.getByRole("button", { name: "Updates", exact: true }).click();
	await expect(sectionHeading(reopened)).toHaveText("Updates");
	await expect(row(reopened, "Channel")).toBeVisible();
	await reopened.evaluate(async () => {
		for (let frame = 0; frame < 30; frame += 1) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
	});
	expect(await flashes()).toEqual([]);

	// The Gateway pane for "updates" still gets the request and reveals its row.
	await release?.();
	const gateway = await gatewayFromSettings(page, reopened);
	await gateway.getByRole("button", { name: "Updates", exact: true }).click();
	await expect(sectionHeading(gateway)).toHaveText("Updates");
	const target = row(gateway, "Channel");
	await expect(target).toBeVisible();
	await expect.poll(flashes).toEqual(["gateway"]);
	expect((await revealState(target)).inView).toBe(true);
	expect(errors).toEqual([]);
});
