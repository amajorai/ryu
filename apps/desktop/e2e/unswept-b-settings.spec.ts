import { expect, type Locator, type Page, test } from "@playwright/test";

// Settings search → navigation → reveal, keyboard operation, and the lazy
// Settings entry point, against the unswept-b story (production
// `LazySettingsDialog` + `LazyGatewayDialog`, store-driven like NavUser,
// local API fixtures, the app's Toaster).

declare global {
	interface Window {
		__unsweptBAnimate?: Element["animate"];
		__unsweptBApiCalls: Array<{ method: string; path: string }>;
		__unsweptBFlashes?: Record<string, number>;
		/** Which dialog was open each time a watched row was flashed. */
		__unsweptBFlashLog?: string[];
		__unsweptBNative?: Array<{ args: unknown; command: string }>;
		__unsweptBOpenChanges: boolean[];
		__unsweptBSettingsTabs?: unknown[];
	}
}

const STORY = "/unswept-b-settings.html";

function settingsDialog(page: Page): Locator {
	return page.locator('[data-slot="dialog-content"]').first();
}

/** The content pane's section heading (its first h2). */
function sectionHeading(dialog: Locator): Locator {
	return dialog.locator("h2").first();
}

function searchBox(dialog: Locator): Locator {
	return dialog.getByRole("textbox", { name: "Search settings", exact: true });
}

/** A settings row in the content pane whose title reads exactly `title`. */
function row(dialog: Locator, title: string): Locator {
	return dialog
		.locator('[data-slot="item"]')
		.filter({
			has: dialog.page().locator('[data-slot="item-title"]', {
				hasText: new RegExp(`^${title}$`),
			}),
		})
		.first();
}

/** A search result button whose first line is exactly `label`. */
function result(dialog: Locator, label: string): Locator {
	return dialog
		.locator('[data-slot="sidebar-menu-button"]')
		.filter({
			has: dialog.page().locator("span > span:first-child", {
				hasText: new RegExp(`^${label}$`),
			}),
		})
		.first();
}

async function openStory(page: Page, errors: string[]) {
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(STORY);
	await expect(page.getByTestId("open-settings")).toBeVisible();
}

async function openSettings(page: Page): Promise<Locator> {
	await page.getByTestId("open-settings").click();
	const dialog = settingsDialog(page);
	await expect(sectionHeading(dialog)).toHaveText("General", {
		timeout: 60_000,
	});
	return dialog;
}

/**
 * Whether `target` is being flashed (a running Web Animation on it) and sits
 * inside its scroll container's visible box once the smooth scroll settles.
 */
async function revealState(target: Locator) {
	return target.evaluate(async (element) => {
		const animated = element.getAnimations().length > 0;
		let scroller: HTMLElement | null = element.parentElement;
		while (scroller) {
			const style = getComputedStyle(scroller);
			if (
				/(auto|scroll)/.test(style.overflowY) &&
				scroller.scrollHeight > scroller.clientHeight
			) {
				break;
			}
			scroller = scroller.parentElement;
		}
		let previous = -1;
		for (let frame = 0; frame < 120; frame += 1) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const top = scroller?.scrollTop ?? 0;
			if (top === previous) {
				break;
			}
			previous = top;
		}
		const box = element.getBoundingClientRect();
		const view = (scroller ?? document.documentElement).getBoundingClientRect();
		return {
			animated,
			inView: box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
			scrolled: (scroller?.scrollTop ?? 0) > 0,
		};
	});
}

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

test("search is keyboard operable: type, Tab to a result, Enter navigates, and focus stays inside the dialog for the next query", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);
	const search = searchBox(dialog);
	await search.focus();
	await page.keyboard.type("Sticky folders");
	await expect(result(dialog, "Sticky folders")).toBeVisible();

	// Tab walks from the search box to the first result.
	await page.keyboard.press("Tab");
	await expect(result(dialog, "Sticky folders")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(sectionHeading(dialog)).toHaveText("Appearance");
	await expect(search).toHaveValue("");
	const target = row(dialog, "Sticky folders");
	await expect(target).toBeVisible();
	expect((await revealState(target)).animated).toBe(true);

	// Focus must not have escaped the modal with the result row it was on.
	const focusInside = await dialog.evaluate((element) =>
		element.contains(document.activeElement)
	);
	expect(focusInside).toBe(true);

	await search.focus();
	await page.keyboard.type("Open with");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Space");
	await expect(sectionHeading(dialog)).toHaveText("General");
	await expect(row(dialog, "Open with")).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(page.getByTestId("settings-open-state")).toHaveText("closed");
	expect(errors).toEqual([]);
});

test("matching sections are offered above setting rows, an unmatched query says so, and clearing the query restores the full nav", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);
	const search = searchBox(dialog);

	await search.fill("billing");
	const sections = dialog.getByText("Sections", { exact: true });
	await expect(sections).toBeVisible();
	const billing = dialog.getByRole("button", { name: "Billing", exact: true });
	await expect(billing).toHaveCount(1);
	await expect(dialog.getByText(/No setting matches/)).toHaveCount(0);
	await billing.click();
	await expect(sectionHeading(dialog)).toHaveText("Billing");
	await expect(search).toHaveValue("");

	await search.fill("   zzqxv   ");
	await expect(
		dialog.getByText("No setting matches “zzqxv”.", { exact: true })
	).toBeVisible();
	await expect(sections).toHaveCount(0);
	await expect(dialog.getByText("Account", { exact: true })).toHaveCount(0);

	await search.fill("");
	for (const group of ["Account", "Services", "Advanced"]) {
		await expect(
			dialog.getByText(group, { exact: true }).first()
		).toBeVisible();
	}
	await expect(sectionHeading(dialog)).toHaveText("Billing");
	expect(errors).toEqual([]);
});

test("Send feedback that cannot reach a browser tells the user instead of failing silently", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);
	await page.evaluate(() => {
		window.__unsweptBNative = [];
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke: (command: string, args: unknown) => {
					window.__unsweptBNative?.push({ args, command });
					return Promise.reject(new Error("open_external: no default browser"));
				},
				transformCallback: () => 0,
			},
		});
	});
	await dialog
		.getByRole("button", { name: "Send feedback", exact: true })
		.click();
	await expect(
		page.getByText("Couldn't open feedback", { exact: true })
	).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.__unsweptBNative?.filter(
				(call) => call.command === "open_external"
			)
		)
	).toEqual([
		{ args: { url: "https://ryuhq.userjot.com/" }, command: "open_external" },
	]);
	// The dialog stays open on the same section.
	await expect(sectionHeading(dialog)).toHaveText("General");
	expect(errors).toEqual([]);
});

test("the training-data links open the configured legal pages from the keyboard", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);
	await page.evaluate(() => {
		window.__unsweptBNative = [];
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke: (command: string, args: unknown) => {
					window.__unsweptBNative?.push({ args, command });
					return Promise.resolve(undefined);
				},
				transformCallback: () => 0,
			},
		});
	});
	await expect(dialog.getByText("We never train on your data.")).toBeVisible();
	await dialog.getByRole("button", { name: "Privacy", exact: true }).focus();
	await page.keyboard.press("Enter");
	await page.keyboard.press("Tab");
	await expect(
		dialog.getByRole("button", { name: "Terms", exact: true })
	).toBeFocused();
	await page.keyboard.press("Space");
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.__unsweptBNative
					?.filter((call) => call.command === "open_external")
					.map((call) => (call.args as { url: string }).url)
			)
		)
		.toEqual(["http://localhost:3001/privacy", "http://localhost:3001/terms"]);
	expect(errors).toEqual([]);
});

test("the lazy entry point loads nothing until asked, preloads on focus, shows an accessible loading dialog while the import is held, then the real dialog", async ({
	page,
}) => {
	const errors: string[] = [];
	const requested: string[] = [];
	page.on("request", (request) => {
		if (/\/settings\/SettingsDialog\.tsx/.test(request.url())) {
			requested.push(request.url());
		}
	});
	let release: (() => Promise<void>) | undefined;
	await page.route("**/settings/SettingsDialog.tsx*", async (route) => {
		await new Promise<void>((resolve) => {
			release = async () => {
				await route.continue();
				resolve();
			};
		});
	});
	await openStory(page, errors);
	await page.waitForLoadState("networkidle");
	expect(requested).toEqual([]);

	// Focusing the opener preloads the dialog code, as NavUser's menu item does.
	await page.getByTestId("open-settings").focus();
	await expect.poll(() => requested.length).toBe(1);
	await expect(page.getByTestId("settings-open-state")).toHaveText("closed");

	await page.keyboard.press("Enter");
	const loading = page.getByRole("dialog", { name: "Settings" });
	await expect(loading).toBeVisible();
	await expect(loading).toHaveAccessibleDescription("Opening settings");
	await expect(loading.locator("h2")).toHaveCount(1);
	await expect(
		page.getByRole("textbox", { name: "Search settings" })
	).toHaveCount(0);

	await release?.();
	const dialog = settingsDialog(page);
	await expect(sectionHeading(dialog)).toHaveText("General", {
		timeout: 60_000,
	});
	await expect(searchBox(dialog)).toBeVisible();
	// One import served both the preload and the open.
	expect(requested).toHaveLength(1);

	await page.keyboard.press("Escape");
	await expect(page.getByTestId("settings-open-state")).toHaveText("closed");
	await expect(page.getByTestId("open-settings")).toBeFocused();
	expect(await page.evaluate(() => window.__unsweptBOpenChanges)).toEqual([
		false,
	]);
	expect(errors).toEqual([]);
});

test("a section that does not exist on this surface falls back to General instead of an empty pane", async ({
	page,
}) => {
	const errors: string[] = [];
	await openStory(page, errors);
	await page.getByTestId("switch-to-web").click();
	await expect(page.getByTestId("surface")).toHaveText("web");
	await page.getByTestId("open-keyboard-section").click();
	const dialog = settingsDialog(page);
	await expect(sectionHeading(dialog)).toHaveText("General", {
		timeout: 60_000,
	});
	await expect(
		dialog.getByRole("button", { name: "Keyboard Shortcuts", exact: true })
	).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "Updates", exact: true })
	).toHaveCount(0);
	// Desktop-only settings are not offered by search on this surface either.
	await searchBox(dialog).fill("Projectless");
	await expect(
		dialog.getByText("No setting matches “Projectless”.", { exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);
});

test("a user-scoped plugin tab appears under Plugins and opens its settings; when Core stops reporting it, the open tab falls back to General", async ({
	page,
}) => {
	await page.addInitScript(() => {
		window.__unsweptBSettingsTabs = [
			{
				fields: [
					{
						label: "Autosave notes",
						pref_key: "acme.notes.autosave",
						type: "boolean",
					},
				],
				id: "acme.notes.settings",
				plugin: "acme.notes",
				scope: "user",
				title: "Notes",
			},
			{
				fields: [{ label: "Node-only option", pref_key: "acme.node.option" }],
				id: "acme.node.settings",
				plugin: "acme.node",
				scope: "node",
				title: "Node plugin",
			},
		];
	});
	const errors: string[] = [];
	await openStory(page, errors);
	const dialog = await openSettings(page);
	await expect(dialog.getByText("Plugins", { exact: true })).toBeVisible();
	const pluginTab = dialog.getByRole("button", {
		name: "acme.notes",
		exact: true,
	});
	await expect(pluginTab).toBeVisible();
	// Node-scoped tabs belong to Gateway settings, never to this dialog.
	await expect(
		dialog.getByRole("button", { name: "acme.node", exact: true })
	).toHaveCount(0);

	await pluginTab.click();
	await expect(sectionHeading(dialog)).toHaveText("acme.notes");
	await expect(dialog.getByText("Autosave notes")).toBeVisible();

	// The plugin is disabled or uninstalled: Core stops reporting its tab and
	// the shell asks every surface to refresh.
	await page.evaluate(() => {
		window.__unsweptBSettingsTabs = [];
		window.dispatchEvent(new CustomEvent("ryu:core-refresh"));
	});
	await expect(sectionHeading(dialog)).toHaveText("General");
	await expect(pluginTab).toHaveCount(0);
	await expect(dialog.getByText("Autosave notes")).toHaveCount(0);
	expect(errors).toEqual([]);
});
