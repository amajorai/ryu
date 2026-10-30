import { expect, test } from "@playwright/test";
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

// Settings search keyboard operation, the dialog's own controls and the lazy
// Settings entry point, against the unswept-b story. Search → reveal cases
// are in `unswept-b-settings.spec.ts`.

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

test("the training-data Learn more opens the public commitment from the keyboard", async ({
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
	await dialog.getByRole("button", { name: "Learn more", exact: true }).focus();
	await page.keyboard.press("Enter");
	await page.keyboard.press("Space");
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.__unsweptBNative
					?.filter((call) => call.command === "open_external")
					.map((call) => (call.args as { url: string }).url)
			)
		)
		.toEqual([
			"http://localhost:3001/docs/surfaces/desktop/transparency#training-commitment",
			"http://localhost:3001/docs/surfaces/desktop/transparency#training-commitment",
		]);
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
