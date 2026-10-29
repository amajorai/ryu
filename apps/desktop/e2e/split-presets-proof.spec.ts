import { expect, test } from "@playwright/test";

const STORY_URL = "/split-presets-proof.html";
const SAVED_ROUTE_PRESET = {
	createdAt: 1,
	id: "preset-saved-route-layout",
	name: "Saved route layout",
	root: {
		children: [
			{ type: "slot", path: "/chat" },
			{ type: "slot", path: "/marketplace" },
		],
		orientation: "rows",
		sizes: [0.4, 0.6],
		type: "branch",
	},
};

function observeBrowserErrors(
	page: import("@playwright/test").Page,
	errors: string[] = []
) {
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

async function seedPresets(
	page: import("@playwright/test").Page,
	presets: unknown[] = []
) {
	await page.addInitScript((storedPresets) => {
		localStorage.clear();
		if (storedPresets.length > 0) {
			localStorage.setItem("ryu_split_presets", JSON.stringify(storedPresets));
		}
	}, presets);
}

async function openSplitMenu(page: import("@playwright/test").Page) {
	await page.getByTestId("split-target").click({ button: "right" });
	await expect(page.getByRole("menu")).toBeVisible();
}

async function openApplySubmenu(page: import("@playwright/test").Page) {
	const apply = page.getByRole("menuitem", { name: "Apply layout preset" });
	await expect(apply).toBeVisible();
	await apply.hover();
}

test("saving a pane preset validates the name, supports cancel, and stores pinned routes", async ({
	page,
}) => {
	await seedPresets(page);
	await page.goto(STORY_URL);
	await openSplitMenu(page);
	await page.getByRole("menuitem", { name: "Save layout as preset" }).click();

	const dialog = page.getByRole("dialog");
	const name = dialog.getByRole("textbox", { name: "Name" });
	const rememberRoutes = dialog.getByRole("checkbox", {
		name: /Remember what each pane was showing/u,
	});
	await expect(
		dialog.getByRole("heading", { name: "Save layout as preset" })
	).toBeVisible();
	await expect(name).toHaveValue("2-pane layout");
	await expect(rememberRoutes).not.toBeChecked();

	await name.fill("   ");
	await expect(
		dialog.getByRole("button", { name: "Save preset" })
	).toBeDisabled();
	await name.press("Enter");
	await expect(dialog).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_split_presets")))
		.toBeNull();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_split_presets")))
		.toBeNull();

	await openSplitMenu(page);
	await page.getByRole("menuitem", { name: "Save layout as preset" }).click();
	const reopenedDialog = page.getByRole("dialog");
	const reopenedName = reopenedDialog.getByRole("textbox", { name: "Name" });
	await reopenedName.fill("Workspace handoff");
	await reopenedDialog
		.getByRole("checkbox", { name: /Remember what each pane was showing/u })
		.check();
	await page.screenshot({
		path: test.info().outputPath("desktop-split-preset-save-dialog.png"),
		fullPage: true,
	});
	await reopenedDialog.getByRole("button", { name: "Save preset" }).click();

	const stored = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu_split_presets") ?? "[]")
	);
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({ name: "Workspace handoff" });
	expect(stored[0].root.children).toEqual([
		{ type: "slot", path: "/chat" },
		{ type: "slot", path: "/marketplace" },
	]);
});

test("shape-only presets omit pages when the remember-routes option stays off", async ({
	page,
}) => {
	await seedPresets(page);
	await page.goto(STORY_URL);
	await openSplitMenu(page);
	await page.getByRole("menuitem", { name: "Save layout as preset" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("textbox", { name: "Name" }).fill("Shape only");
	await expect(
		dialog.getByRole("checkbox", {
			name: /Remember what each pane was showing/u,
		})
	).not.toBeChecked();
	await dialog.getByRole("textbox", { name: "Name" }).press("Enter");
	await expect(dialog).toHaveCount(0);

	const stored = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu_split_presets") ?? "[]")
	);
	expect(stored[0].name).toBe("Shape only");
	expect(stored[0].root.children).toEqual([{ type: "slot" }, { type: "slot" }]);
});

test("apply presets retile matching panes, create new panes for a mismatch, and equalize", async ({
	page,
}) => {
	await seedPresets(page, [SAVED_ROUTE_PRESET]);
	await page.goto(STORY_URL);
	await expect(page.getByTestId("split-sizes")).toHaveText("0.7,0.3");

	await openSplitMenu(page);
	const equalize = page.getByRole("menuitem", { name: "Equalize panes" });
	await expect(equalize).toBeEnabled();
	await equalize.click();
	await expect(page.getByTestId("split-sizes")).toHaveText("0.5,0.5");

	await openSplitMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Equalize panes" })
	).toBeDisabled();
	await openApplySubmenu(page);
	await page.getByRole("menuitem", { name: /Stacked/u }).click();
	await expect(page.getByTestId("split-orientation")).toHaveText("rows");
	await expect(page.getByTestId("apply-result")).toHaveText(
		"Existing panes: rows"
	);

	await openSplitMenu(page);
	await openApplySubmenu(page);
	await page.getByRole("menuitem", { name: /Saved route layout/u }).click();
	await expect(page.getByTestId("apply-result")).toHaveText(
		"Existing panes: rows"
	);
	await expect(page.getByTestId("pane-order")).toHaveText("pane-a,pane-b");
	await expect(page.getByTestId("split-sizes")).toHaveText("0.4,0.6");

	await openSplitMenu(page);
	await openApplySubmenu(page);
	await page.getByRole("menuitem", { name: /Three columns/u }).click();
	await expect(page.getByTestId("apply-result")).toHaveText(
		"New panes: 3 panes · side by side"
	);
	await expect(page.getByTestId("split-orientation")).toHaveText("columns");
	await expect(page.getByTestId("pane-count")).toHaveText("3");
	await expect(page.getByTestId("active-split-id")).toHaveText(
		"preset-split-1"
	);
	await expect(page.getByTestId("pane-order")).toHaveText(
		"preset-split-1-pane-1,preset-split-1-pane-2,preset-split-1-pane-3"
	);
	await expect(page.getByTestId("split-count")).toHaveText("2");
	await expect(page.getByTestId("all-split-layouts")).toContainText(
		"proof-split:rows:0.4,0.6:pane-a,pane-b"
	);
});

test("a refused save retains its focused draft and saves the captured shape on retry", async ({
	page,
}) => {
	const browserErrors = observeBrowserErrors(page);
	await seedPresets(page);
	await page.goto(STORY_URL);
	await openSplitMenu(page);
	await page.getByRole("menuitem", { name: "Save layout as preset" }).click();
	const dialog = page.getByRole("dialog");
	const name = dialog.getByRole("textbox", { name: "Name" });
	await name.fill("Storage recovery");
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key: string, value: string) {
			if (key === "ryu_split_presets") {
				throw new DOMException("Storage quota reached", "QuotaExceededError");
			}
			return original.call(this, key, value);
		};
		window.addEventListener(
			"proof:restore-storage",
			() => {
				Storage.prototype.setItem = original;
			},
			{ once: true }
		);
	});
	await name.press("Enter");
	await expect(dialog.getByRole("alert")).toHaveText(
		"Could not save this layout. Check available storage and try again."
	);
	await expect(name).toHaveValue("Storage recovery");
	await expect(name).toBeFocused();
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_split_presets"))
	).toBeNull();
	await page.evaluate(() =>
		window.dispatchEvent(new Event("proof:restore-storage"))
	);
	await name.press("Enter");
	await expect(dialog).toHaveCount(0);
	const stored = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu_split_presets") ?? "[]")
	);
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({
		name: "Storage recovery",
		root: {
			orientation: "columns",
			sizes: [0.7, 0.3],
			children: [{ type: "slot" }, { type: "slot" }],
		},
	});
	const independent = await page.context().newPage();
	observeBrowserErrors(independent, browserErrors);
	try {
		await independent.goto(STORY_URL);
		await openSplitMenu(independent);
		await openApplySubmenu(independent);
		await expect(
			independent.getByRole("menuitem", { name: /Storage recovery/u })
		).toBeVisible();
	} finally {
		await independent.close();
	}
	expect(browserErrors).toEqual([]);
});

test("capacity refusal keeps the save dialog and every unrelated layout until replacement", async ({
	page,
}) => {
	const browserErrors = observeBrowserErrors(page);
	const seed = Array.from({ length: 60 }, (_, index) => ({
		...SAVED_ROUTE_PRESET,
		id: `capacity-${index}`,
		name: `Layout ${index}`,
	}));
	await seedPresets(page, seed);
	await page.goto(STORY_URL);
	await openSplitMenu(page);
	await page.getByRole("menuitem", { name: "Save layout as preset" }).click();
	const dialog = page.getByRole("dialog");
	const name = dialog.getByRole("textbox", { name: "Name" });
	await name.fill("New layout");
	await name.press("Enter");
	await expect(dialog.getByRole("alert")).toHaveText(
		"The saved layout limit has been reached. Use an existing name to replace a layout, or delete a saved layout first."
	);
	await expect(name).toHaveValue("New layout");
	expect(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu_split_presets") ?? "[]")
		)
	).toEqual(seed);
	await name.fill("LAYOUT 29");
	await name.press("Enter");
	await expect(dialog).toHaveCount(0);
	const stored = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu_split_presets") ?? "[]")
	);
	expect(stored).toHaveLength(60);
	expect(
		stored.filter(
			(preset: { name: string }) => preset.name.toLowerCase() !== "layout 29"
		)
	).toEqual(seed.filter((preset) => preset.name !== "Layout 29"));
	expect(
		stored.find((preset: { name: string }) => preset.name === "LAYOUT 29")
	).toMatchObject({ root: { orientation: "columns", sizes: [0.7, 0.3] } });
	expect(browserErrors).toEqual([]);
});
