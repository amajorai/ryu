import path from "node:path";
import { expect, test } from "@playwright/test";
import { parsePresets } from "../src/lib/splitPresets.ts";

test.describe.configure({ timeout: 90_000 });

const PRESET_EDITOR_SCREENSHOT = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-pane-presets.png"
);

test("double-click opens and commits the inline rename editors", async ({
	page,
}, testInfo) => {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));

	await page.goto("/tab-renames-proof.html");
	await expect(page).toHaveTitle("Inline renames proof");
	await expect(page.getByTestId("group-name")).toHaveText("Research");

	await page.getByTestId("tab-group-header").dblclick();
	const groupInput = page.getByRole("textbox").first();
	await expect(groupInput).toHaveValue("Research");
	await groupInput.fill("Client research");
	await groupInput.press("Enter");
	await expect(page.getByTestId("group-name")).toHaveText("Client research");

	const presetTitle = page.getByText("Editorial layout", { exact: true });
	await presetTitle.dblclick();
	const presetInput = page.getByRole("textbox", {
		name: "New name for Editorial layout",
	});
	await expect(presetInput).toHaveValue("Editorial layout");
	await presetInput.fill("Review layout");
	await presetInput.press("Enter");
	await expect(page.getByText("Review layout", { exact: true })).toBeVisible();
	await page.mouse.move(10, 10);
	await page.waitForTimeout(200);
	await page.screenshot({
		path: testInfo.outputPath("inline-renames-proof.png"),
	});

	expect(consoleErrors).toEqual([]);
	expect(pageErrors).toEqual([]);
});

test("pane preset rename, cancel, keyboard cancel, and persistence work", async ({
	page,
}) => {
	await page.goto("/tab-renames-proof.html");
	await expect(page.getByText("1 saved", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Rename Editorial layout" }).click();
	const initialInput = page.getByRole("textbox", {
		name: "New name for Editorial layout",
	});
	await expect(initialInput).toHaveValue("Editorial layout");
	await initialInput.fill("   ");
	await expect(
		page.getByRole("button", { name: "Rename", exact: true })
	).toBeDisabled();
	await initialInput.fill("Client review layout");
	await expect(
		page.getByRole("button", { name: "Rename", exact: true })
	).toBeEnabled();
	await page.screenshot({ path: PRESET_EDITOR_SCREENSHOT, fullPage: true });
	await page.getByRole("button", { name: "Rename", exact: true }).click();
	await expect(
		page.getByText("Client review layout", { exact: true })
	).toBeVisible();
	await expect
		.poll(async () => {
			const raw = await page.evaluate(
				() => localStorage.getItem("ryu_split_presets") ?? "[]"
			);
			return parsePresets(JSON.parse(raw))[0]?.name;
		})
		.toBe("Client review layout");

	await page
		.getByRole("button", { name: "Rename Client review layout" })
		.click();
	await page
		.getByRole("textbox", { name: "New name for Client review layout" })
		.fill("Canceled layout name");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByText("Client review layout", { exact: true })
	).toBeVisible();

	await page
		.getByRole("button", { name: "Rename Client review layout" })
		.click();
	const canceledInput = page.getByRole("textbox", {
		name: "New name for Client review layout",
	});
	await canceledInput.fill("Canceled with Escape");
	await canceledInput.press("Escape");
	await expect(canceledInput).toHaveCount(0);
	await expect(
		page.getByText("Client review layout", { exact: true })
	).toBeVisible();
});

test("pane preset deletion can be canceled or confirmed", async ({ page }) => {
	await page.goto("/tab-renames-proof.html");

	await page.getByRole("button", { name: "Delete Editorial layout" }).click();
	await expect(
		page.getByText(
			/Delete “Editorial layout”\? Panes already open are not affected\./u
		)
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByText("Editorial layout", { exact: true })
	).toBeVisible();
	await expect(page.getByText("1 saved", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Delete Editorial layout" }).click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(page.getByText("None saved yet", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete Editorial layout" })
	).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_split_presets")))
		.toBeNull();
});
