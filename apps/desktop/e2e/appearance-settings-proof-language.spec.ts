import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { parseLanguagePackArchive } from "@ryu/i18n/core";
import { appearanceLanguageRequestsSchema } from "./appearance-proof.contracts.ts";
import {
	LANGUAGE_PACK_EVIDENCE_PATH,
	openPage,
	STORY_URL,
	selectOption,
} from "./appearance-settings-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("language settings select, export, enable, import, and open the marketplace", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Language & vibe");

	const languagePicker = page.getByRole("list").first().getByRole("combobox");
	/**
	 * A language choice re-renders the open Language page in place: the page
	 * stays open in the new language and its index row is not shown. An
	 * immediate choice also keeps keyboard focus on the picker; enabling a
	 * disabled pack disables the picker while Core works, so focus is not
	 * checked for that choice.
	 */
	const expectLanguagePageOpen = async (labels: {
		back: string;
		choice: string;
		focused: boolean;
		title: string;
	}) => {
		await expect(
			page.getByRole("button", { name: labels.back, exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("heading", { level: 3, name: labels.title, exact: true })
		).toHaveCount(2);
		await expect(
			page.getByRole("button", { name: labels.title, exact: true })
		).toHaveCount(0);
		await expect(languagePicker).toContainText(labels.choice);
		if (labels.focused) {
			await expect(languagePicker).toBeFocused();
		}
	};
	await selectOption(page, languagePicker, "Español");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-mode")))
		.toBe("fixed");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-pack")))
		.toBe("official/es");
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	await expectLanguagePageOpen({
		back: "Apariencia",
		choice: "Español",
		focused: true,
		title: "Idioma y estilo",
	});
	await selectOption(page, languagePicker, "Detectar automáticamente");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-mode")))
		.toBe("auto");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-pack")))
		.toBeNull();
	await expectLanguagePageOpen({
		back: "Appearance",
		choice: "Auto detect",
		focused: true,
		title: "Language & vibe",
	});

	await selectOption(page, languagePicker, "Coverage disabled voice");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-pack")))
		.toBe("proof/disabled-voice");
	await expectLanguagePageOpen({
		back: "Appearance",
		choice: "Coverage disabled voice",
		focused: false,
		title: "Language & vibe",
	});
	const requests = appearanceLanguageRequestsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(
				localStorage.getItem("ryu_appearance_language_requests") ?? "[]"
			)
		)
	);
	expect(requests).toContainEqual({
		method: "POST",
		path: "/api/marketplace/packages/language_pack/proof%2Fdisabled-voice/enable",
	});

	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import", exact: true }).click();
	const fileChooser = await fileChooserPromise;
	await fileChooser.setFiles({
		buffer: Buffer.from("fixture language archive"),
		mimeType: "application/zip",
		name: "coverage.ryupack",
	});
	await expect(
		page.getByText("Coverage imported voice", { exact: true }).nth(1)
	).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-pack")))
		.toBe("proof/imported-voice");
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath(LANGUAGE_PACK_EVIDENCE_PATH),
	});
	const packName = "Coverage imported voice";
	const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
	await page.getByRole("button", { name: `Export ${packName}` }).click();
	const download = await downloadPromise;
	const archivePath = await download.path();
	if (!archivePath) {
		throw new Error(
			"Playwright did not preserve the downloaded language pack."
		);
	}
	const archive = await readFile(archivePath);
	expect(download.suggestedFilename()).toBe(
		"coverage-imported-voice-1.0.0.ryupack"
	);
	expect(archive.byteLength).toBeGreaterThan(0);
	const pack = parseLanguagePackArchive(new Uint8Array(archive));
	expect(pack.name).toBe(packName);
	expect(pack.id).toBe("proof/imported-voice");
	expect(pack.messages).toEqual({ "common.marketplace": "Marketplace" });
});

test("language settings Marketplace action navigates to the catalog", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await openPage(page, "Language & vibe");
	await page.getByRole("button", { name: "Marketplace", exact: true }).click();
	await expect(page.getByTestId("proof-route")).toHaveText("/marketplace");
});

test("chat detail presets, advanced controls, and message preferences respond", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Chat view");

	const detail = page.getByRole("slider", { name: "Detail level" });
	await expect(detail).toBeVisible();
	await detail.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:hide-tool-detail"))
		)
		.toBe("false");

	await page.getByRole("button", { name: "Advanced detail" }).click();
	const advancedSwitches = [
		["group-tool-uses-toggle", "ryu:group-tool-uses"],
		["expand-file-edits-toggle", "ryu:expand-file-edits"],
		["expand-commands-toggle", "ryu:expand-commands"],
		["expand-code-blocks-toggle", "ryu:expand-code-blocks"],
	] as const;
	for (const [index, [, storageKey]] of advancedSwitches.entries()) {
		const control = page.getByRole("switch").nth(index);
		await expect(control).toBeVisible();
		const before = await control.isChecked();
		await control.click();
		await expect(control).toBeChecked({ checked: !before });
		await expect
			.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
			.toBe(String(!before));
	}

	const messagePreferences = [
		["pin-user-message-toggle", "ryu:pin-user-message"],
		["open-chat-at-bottom-toggle", "ryu:open-chat-at-bottom"],
		["inference-stats-toggle", "ryu:inference-stats"],
	] as const;
	for (const [index, [, key]] of messagePreferences.entries()) {
		const control = page.getByRole("switch").nth(index + 4);
		const before = await control.isChecked();
		await control.click();
		await expect(control).toBeChecked({ checked: !before });
		await expect
			.poll(() =>
				page.evaluate((storageKey) => localStorage.getItem(storageKey), key)
			)
			.toBe(String(!before));
	}
	const changedChatChecks = await page
		.getByRole("switch")
		.evaluateAll((controls) =>
			controls.map((control) => control.getAttribute("aria-checked") === "true")
		);
	const changedChatStorage = await page.evaluate(
		(keys) =>
			Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
		[
			...advancedSwitches.map(([, key]) => key),
			...messagePreferences.map(([, key]) => key),
		]
	);
	await page.reload();
	await openPage(page, "Chat view");
	await page.getByRole("button", { name: "Advanced detail" }).click();
	for (const [index, checked] of changedChatChecks.entries()) {
		await expect(page.getByRole("switch").nth(index)).toBeChecked({ checked });
	}
	for (const [key, value] of Object.entries(changedChatStorage)) {
		await expect
			.poll(() =>
				page.evaluate((storageKey) => localStorage.getItem(storageKey), key)
			)
			.toBe(value);
	}
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-appearance-chat-settings-proof.png"),
	});
});
