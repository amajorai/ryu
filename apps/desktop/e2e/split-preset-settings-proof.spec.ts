import { expect, test } from "@playwright/test";
import { parseProofJson } from "./fixture-json.ts";

const SPLIT_PRESETS_KEY = "ryu_split_presets";
const SEED_KEY = "__split_preset_settings_proof_seeded";
const STORY_URL = "/split-preset-settings-proof.html";
const RENAMED_SCREENSHOT = "desktop-split-presets-renamed-persisted.png";
const CONFIRM_SCREENSHOT = "desktop-split-presets-delete-confirmation.png";
const DELETED_SCREENSHOT = "desktop-split-presets-delete-readback.png";

const INITIAL_PRESETS = [
	{
		id: "proof:research",
		name: "Research workspace",
		createdAt: 1_700_000_000_000,
		root: {
			type: "branch",
			orientation: "columns",
			sizes: [0.4, 0.6],
			children: [{ type: "slot", path: "/workspace" }, { type: "slot" }],
		},
	},
	{
		id: "proof:references",
		name: "Reference board",
		createdAt: 1_700_000_000_001,
		root: {
			type: "branch",
			orientation: "rows",
			sizes: [0.5, 0.5],
			children: [{ type: "slot" }, { type: "slot", path: "/docs" }],
		},
	},
];

async function mountSettings(page: import("@playwright/test").Page) {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.addInitScript(
		({ initialPresets, presetKey, seedKey }) => {
			if (localStorage.getItem(seedKey) !== "1") {
				localStorage.setItem(presetKey, JSON.stringify(initialPresets));
				localStorage.setItem(seedKey, "1");
			}
		},
		{
			initialPresets: INITIAL_PRESETS,
			presetKey: SPLIT_PRESETS_KEY,
			seedKey: SEED_KEY,
		}
	);
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("heading", { name: "Pane layouts" })
	).toBeVisible();
	await expect(page.getByText("2 saved", { exact: true })).toBeVisible();
	return { browserErrors };
}

async function readStoredPresets(page: import("@playwright/test").Page) {
	const stored = await page.evaluate(
		(key) => localStorage.getItem(key),
		SPLIT_PRESETS_KEY
	);
	return stored ? parseProofJson(stored) : [];
}

test("renames through the inline editor, rejects blank Enter, and persists the named shape", async ({
	page,
}) => {
	const { browserErrors } = await mountSettings(page);
	const renameButton = (name: string) =>
		page.getByRole("button", { name: `Rename ${name}` });
	await renameButton("Research workspace").click();
	const editor = page.getByRole("textbox", {
		name: "New name for Research workspace",
	});
	const confirmRename = page.getByRole("button", {
		name: "Rename",
		exact: true,
	});
	await editor.fill("   ");
	await expect(confirmRename).toBeDisabled();
	await editor.press("Enter");
	await expect(editor).toBeVisible();
	await expect(editor).toHaveValue("   ");
	await expect(await readStoredPresets(page)).toEqual(INITIAL_PRESETS);

	await editor.fill("  Architecture layout  ");
	await editor.press("Enter");
	await expect(renameButton("Architecture layout")).toBeVisible();
	const renamed = [
		{ ...INITIAL_PRESETS[0], name: "Architecture layout" },
		INITIAL_PRESETS[1],
	];
	await expect(await readStoredPresets(page)).toEqual(renamed);

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(renameButton("Architecture layout")).toBeVisible();
	await expect(page.getByText("2 saved", { exact: true })).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath(RENAMED_SCREENSHOT),
		fullPage: true,
	});

	await renameButton("Architecture layout").click();
	const cancelEditor = page.getByRole("textbox", {
		name: "New name for Architecture layout",
	});
	await cancelEditor.fill("Discard this draft");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(renameButton("Architecture layout")).toBeVisible();
	await expect(await readStoredPresets(page)).toEqual(renamed);

	await page.getByText("Architecture layout", { exact: true }).dblclick();
	const doubleClickEditor = page.getByRole("textbox", {
		name: "New name for Architecture layout",
	});
	await expect(doubleClickEditor).toBeVisible();
	await doubleClickEditor.fill("Discard with Escape");
	await doubleClickEditor.press("Escape");
	await expect(doubleClickEditor).toHaveCount(0);
	await expect(renameButton("Architecture layout")).toBeVisible();
	await expect(await readStoredPresets(page)).toEqual(renamed);
	expect(browserErrors).toEqual([]);
});

test("deletion requires confirmation, cancel preserves state, and confirmed delete persists", async ({
	page,
}) => {
	const { browserErrors } = await mountSettings(page);
	const deleteButton = (name: string) =>
		page.getByRole("button", { name: `Delete ${name}` });
	const confirmation =
		"Delete “Research workspace”? Panes already open are not affected.";
	await deleteButton("Research workspace").click();
	await expect(page.getByText(confirmation, { exact: true })).toBeVisible();
	await expect(await readStoredPresets(page)).toEqual(INITIAL_PRESETS);
	await page.screenshot({
		path: test.info().outputPath(CONFIRM_SCREENSHOT),
		fullPage: true,
	});

	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(deleteButton("Research workspace")).toBeVisible();
	await expect(await readStoredPresets(page)).toEqual(INITIAL_PRESETS);

	await deleteButton("Research workspace").click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	const remainingPresets = [INITIAL_PRESETS[1]];
	await expect(page.getByText("1 saved", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Research workspace", { exact: true })
	).toHaveCount(0);
	await expect(await readStoredPresets(page)).toEqual(remainingPresets);

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByText("1 saved", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Reference board", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Research workspace", { exact: true })
	).toHaveCount(0);
	await expect(await readStoredPresets(page)).toEqual(remainingPresets);
	await page.screenshot({
		path: test.info().outputPath(DELETED_SCREENSHOT),
		fullPage: true,
	});
	expect(browserErrors).toEqual([]);
});

async function refuseLayoutWrites(page: import("@playwright/test").Page) {
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
}
async function restoreLayoutWrites(page: import("@playwright/test").Page) {
	await page.evaluate(() =>
		window.dispatchEvent(new Event("proof:restore-storage"))
	);
}

test("failed rename retains focused draft, unchanged collection and permits retry", async ({
	page,
}) => {
	const { browserErrors } = await mountSettings(page);
	await page.getByRole("button", { name: "Rename Research workspace" }).click();
	const editor = page.getByRole("textbox", {
		name: "New name for Research workspace",
	});
	await expect(editor).toBeFocused();
	await editor.fill("Recovered layout");
	await refuseLayoutWrites(page);
	await editor.press("Enter");
	await expect(page.getByRole("alert")).toHaveText(
		"Could not rename this layout. Check available storage and try again."
	);
	await expect(editor).toHaveValue("Recovered layout");
	await expect(editor).toBeFocused();
	expect(await readStoredPresets(page)).toEqual(INITIAL_PRESETS);
	await restoreLayoutWrites(page);
	await editor.press("Enter");
	await expect(editor).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveCount(0);
	const expected = [
		{ ...INITIAL_PRESETS[0], name: "Recovered layout" },
		INITIAL_PRESETS[1],
	];
	expect(await readStoredPresets(page)).toEqual(expected);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Rename Recovered layout" })
	).toBeVisible();
	expect(await readStoredPresets(page)).toEqual(expected);
	expect(browserErrors).toEqual([]);
});

test("failed confirmed deletion keeps confirmation and every record until acknowledged retry", async ({
	page,
}) => {
	const { browserErrors } = await mountSettings(page);
	await page.getByRole("button", { name: "Delete Research workspace" }).click();
	await refuseLayoutWrites(page);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Could not delete this layout. Check available storage and try again."
	);
	await expect(
		page.getByText(
			"Delete “Research workspace”? Panes already open are not affected.",
			{ exact: true }
		)
	).toBeVisible();
	expect(await readStoredPresets(page)).toEqual(INITIAL_PRESETS);
	await restoreLayoutWrites(page);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	expect(await readStoredPresets(page)).toEqual([INITIAL_PRESETS[1]]);
	await page.reload();
	await expect(page.getByText("1 saved", { exact: true })).toBeVisible();
	expect(await readStoredPresets(page)).toEqual([INITIAL_PRESETS[1]]);
	expect(browserErrors).toEqual([]);
});
