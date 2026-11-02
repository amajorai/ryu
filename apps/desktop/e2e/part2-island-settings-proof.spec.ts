// Continues island-settings-proof.spec.ts (split under the file token limit); helpers live in island-settings-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	armFailure,
	evidencePath,
	expectNodeAuthorization,
	expectPreference,
	NODE_TOKEN,
	openIslandSettings,
	preferenceWrite,
	preferenceWrites,
	readProof,
	selectOption,
	shadowWrites,
	WINDOWS_USER_AGENT,
} from "./island-settings-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("persists all background choices, debounced edge offsets, and visibility settings", async ({
	browser,
	page,
}) => {
	// The page clock runs naturally until the offset section pauses it, so
	// the 200 ms write debounce elapses only when the test advances it. With
	// real time, a loaded host spaces drag steps more than 200 ms apart and the
	// product correctly writes the intermediate values as well.
	await page.clock.install();
	await openIslandSettings(page);
	const fullscreen = page.getByRole("switch", {
		name: "Hide on fullscreen apps",
	});
	await expect(fullscreen).toBeDisabled();
	await expect(
		preferenceWrites(await readProof(page), "island-hide-on-fullscreen")
	).toEqual([]);

	const background = page.getByRole("combobox", { name: "Background" });
	await expect(background).toContainText("Native glass (default)");
	await armFailure(page, "PUT", "/api/preferences/island-appearance", 503);
	await selectOption(page, "Background", "Translucent (tinted glass)");
	await expect(page.getByRole("alert")).toHaveText(
		"Couldn't save Island setting. The previous value was restored. Choose the setting again to retry."
	);
	await expect(background).toContainText("Native glass (default)");
	await expectPreference(
		page,
		"island-appearance",
		JSON.stringify({ background: "acrylic" })
	);
	await page.getByRole("alert").scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-background-write-rollback"),
	});
	await selectOption(page, "Background", "Translucent (tinted glass)");
	await expect(background).toContainText("Translucent (tinted glass)");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expectPreference(
		page,
		"island-appearance",
		JSON.stringify({ background: "translucent" })
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-translucent-persisted"),
	});
	await selectOption(page, "Background", "Mica (Windows 11 native blur)");
	await expect(background).toContainText("Mica (Windows 11 native blur)");
	await expectPreference(
		page,
		"island-appearance",
		JSON.stringify({ background: "mica" })
	);
	await selectOption(page, "Background", "Native glass (default)");
	await expect(background).toContainText("Native glass (default)");
	await expectPreference(
		page,
		"island-appearance",
		JSON.stringify({ background: "acrylic" })
	);

	const offset = page.getByRole("slider", { name: "Offset from edge" });
	await expect(offset).toHaveAttribute("aria-valuenow", "20");
	const offsetWrites = async () =>
		preferenceWrites(await readProof(page), "island-edge-offset");
	// Freeze page time: every change below lands at one instant, and the
	// debounced write fires only when the test runs the clock past 200 ms.
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
	await offset.focus();
	for (let step = 0; step < 5; step += 1) {
		await page.keyboard.press("ArrowRight");
	}
	await expect(offset).toHaveAttribute("aria-valuenow", "25");
	await page.clock.runFor(199);
	expect(await offsetWrites()).toEqual([]);
	await page.clock.runFor(1);
	await expect
		.poll(offsetWrites)
		.toEqual([preferenceWrite("island-edge-offset", "25")]);
	const offsetBox = await offset.boundingBox();
	if (!offsetBox) {
		throw new Error("Offset slider has no layout box");
	}
	const sliderY = offsetBox.y + offsetBox.height / 2;
	await page.mouse.move(offsetBox.x + offsetBox.width * 0.2, sliderY);
	await page.mouse.down();
	await page.mouse.move(offsetBox.x + offsetBox.width * 0.5, sliderY, {
		steps: 4,
	});
	await page.mouse.up();
	await expect(offset).toHaveAttribute("aria-valuenow", "48");
	// The drag's intermediate values (real time on a loaded host wrote 19, 26,
	// 34 and 41) all land inside one paused instant, so none is written.
	expect(await offsetWrites()).toEqual([
		preferenceWrite("island-edge-offset", "25"),
	]);
	await page.clock.runFor(200);
	await expect
		.poll(offsetWrites)
		.toEqual([
			preferenceWrite("island-edge-offset", "25"),
			preferenceWrite("island-edge-offset", "48"),
		]);
	await offset.focus();
	await page.keyboard.press("End");
	await expect(offset).toHaveAttribute("aria-valuenow", "96");
	await page.clock.runFor(200);
	await expect
		.poll(offsetWrites)
		.toEqual([
			preferenceWrite("island-edge-offset", "25"),
			preferenceWrite("island-edge-offset", "48"),
			preferenceWrite("island-edge-offset", "96"),
		]);
	await page.keyboard.press("Home");
	await expect(offset).toHaveAttribute("aria-valuenow", "0");
	await page.clock.runFor(200);
	await expect
		.poll(offsetWrites)
		.toEqual([
			preferenceWrite("island-edge-offset", "25"),
			preferenceWrite("island-edge-offset", "48"),
			preferenceWrite("island-edge-offset", "96"),
			preferenceWrite("island-edge-offset", "0"),
		]);
	await page.clock.resume();

	const autoJump = page.getByRole("switch", {
		name: "Auto-jump to active monitor",
	});
	await expect(autoJump).not.toBeChecked();
	await autoJump.click();
	await expect(autoJump).toBeChecked();
	await expectPreference(page, "island-auto-jump", "true");

	const screenPrivacy = page.getByRole("switch", {
		name: "Hide from screen capture",
	});
	await expect(screenPrivacy).toBeChecked();
	await screenPrivacy.click();
	await expect(screenPrivacy).not.toBeChecked();
	await expectPreference(page, "island-screen-privacy", "false");

	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Background" })
	).toContainText("Native glass (default)");
	await expect(
		page.getByRole("slider", { name: "Offset from edge" })
	).toHaveAttribute("aria-valuenow", "0");
	await expect(
		page.getByRole("switch", { name: "Auto-jump to active monitor" })
	).toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Hide from screen capture" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Hide on fullscreen apps" })
	).toBeDisabled();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-native-glass-persisted"),
	});
	await page
		.getByRole("switch", { exact: true, name: "Hide from screen capture" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-visibility-persisted"),
	});

	const saved = await readProof(page);
	expect(preferenceWrites(saved, "island-appearance")).toEqual([
		preferenceWrite(
			"island-appearance",
			JSON.stringify({ background: "translucent" }),
			503
		),
		preferenceWrite(
			"island-appearance",
			JSON.stringify({ background: "translucent" })
		),
		preferenceWrite(
			"island-appearance",
			JSON.stringify({ background: "mica" })
		),
		preferenceWrite(
			"island-appearance",
			JSON.stringify({ background: "acrylic" })
		),
	]);
	expect(preferenceWrites(saved, "island-edge-offset")).toEqual([
		preferenceWrite("island-edge-offset", "25"),
		preferenceWrite("island-edge-offset", "48"),
		preferenceWrite("island-edge-offset", "96"),
		preferenceWrite("island-edge-offset", "0"),
	]);
	expect(preferenceWrites(saved, "island-auto-jump")).toEqual([
		preferenceWrite("island-auto-jump", "true"),
	]);
	expect(preferenceWrites(saved, "island-screen-privacy")).toEqual([
		preferenceWrite("island-screen-privacy", "false"),
	]);
	expectNodeAuthorization(
		saved.requests.filter((request) =>
			request.path.startsWith("/api/preferences/")
		)
	);

	const windowsContext = await browser.newContext({
		userAgent: WINDOWS_USER_AGENT,
		viewport: { height: 900, width: 1440 },
	});
	try {
		const windowsPage = await windowsContext.newPage();
		await openIslandSettings(windowsPage);
		const windowsFullscreen = windowsPage.getByRole("switch", {
			name: "Hide on fullscreen apps",
		});
		await expect(windowsFullscreen).toBeEnabled();
		await expect(windowsFullscreen).toBeChecked();
		await windowsFullscreen.click();
		await expect(windowsFullscreen).not.toBeChecked();
		await expectPreference(windowsPage, "island-hide-on-fullscreen", "false");
		expect(
			preferenceWrites(
				await readProof(windowsPage),
				"island-hide-on-fullscreen"
			)
		).toEqual([preferenceWrite("island-hide-on-fullscreen", "false")]);

		await windowsPage.reload();
		await windowsPage
			.getByRole("button", { name: "Island", exact: true })
			.click();
		await expect(
			windowsPage.getByRole("switch", { name: "Hide on fullscreen apps" })
		).toBeEnabled();
		await expect(
			windowsPage.getByRole("switch", { name: "Hide on fullscreen apps" })
		).not.toBeChecked();
		await windowsPage
			.getByRole("switch", {
				exact: true,
				name: "Hide on fullscreen apps",
			})
			.scrollIntoViewIfNeeded();
		await windowsPage.screenshot({
			animations: "disabled",
			fullPage: true,
			path: evidencePath("island-settings-windows-fullscreen-persisted"),
		});
	} finally {
		await windowsContext.close();
	}
});

test("persists Shadow capture switches through the local store and control API fixtures", async ({
	page,
}) => {
	await openIslandSettings(page);
	const frames = page.getByRole("switch", {
		name: "Screen recording (frames)",
	});
	const paused = page.getByRole("switch", {
		name: "Pause all capture (incognito)",
	});
	await expect(frames).toBeEnabled();
	await expect(frames).toBeChecked();
	await expect(paused).not.toBeChecked();

	await frames.click();
	await expect(frames).not.toBeChecked();
	await expect
		.poll(async () => shadowWrites(await readProof(page)).at(-1)?.body)
		.toEqual({ frames: false });
	await paused.click();
	await expect(paused).toBeChecked();
	await expect
		.poll(async () => shadowWrites(await readProof(page)).at(-1)?.body)
		.toEqual({ paused: true });

	const saved = await readProof(page);
	expect(saved.shadowStore).toEqual({ frames: false, paused: true, saves: 2 });
	expect(saved.shadowControl.frames).toBe(false);
	expect(saved.shadowControl.paused).toBe(true);
	expect(
		saved.tauriCalls
			.filter((call) => call.method === "set")
			.map((call) => ({
				fileName: call.fileName,
				key: call.key,
				value: call.value,
			}))
	).toEqual([
		{
			fileName: "companion.bin",
			key: "companion_frames",
			value: false,
		},
		{
			fileName: "companion.bin",
			key: "companion_paused",
			value: true,
		},
	]);
	expect(
		saved.tauriCalls
			.filter((call) => call.method === "save")
			.map((call) => call.fileName)
	).toEqual(["companion.bin", "companion.bin"]);

	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("switch", { name: "Screen recording (frames)" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Pause all capture (incognito)" })
	).toBeChecked();
	await expect
		.poll(async () => shadowWrites(await readProof(page)).at(-1)?.body)
		.toEqual({
			app_allowlist: [],
			frames: false,
			history_retention_days: 30,
			paused: true,
		});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-shadow-capture-persisted"),
	});
});

test("notch mode persists across reload and rolls back a failed save", async ({
	page,
}) => {
	await openIslandSettings(page);
	const toggle = page.getByRole("switch", { name: "Notch mode", exact: true });
	await expect(toggle).not.toBeChecked();
	await expect
		.poll(async () => {
			const requests = (await readProof(page)).requests;
			return requests.filter(
				(request) =>
					request.method === "GET" &&
					request.path === "/api/preferences/island-notch-mode"
			);
		})
		.toEqual([
			{
				body: null,
				headerAuthorization: `Bearer ${NODE_TOKEN}`,
				method: "GET",
				path: "/api/preferences/island-notch-mode",
				status: 404,
			},
		]);
	await toggle.click();
	await expectPreference(page, "island-notch-mode", "true");
	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(toggle).toBeChecked();
	await expect
		.poll(async () => {
			const requests = (await readProof(page)).requests;
			return requests.filter(
				(request) =>
					request.method === "GET" &&
					request.path === "/api/preferences/island-notch-mode"
			);
		})
		.toEqual([
			{
				body: null,
				headerAuthorization: `Bearer ${NODE_TOKEN}`,
				method: "GET",
				path: "/api/preferences/island-notch-mode",
				status: 404,
			},
			{
				body: null,
				headerAuthorization: `Bearer ${NODE_TOKEN}`,
				method: "GET",
				path: "/api/preferences/island-notch-mode",
				status: 200,
			},
		]);
	await toggle.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-notch-mode-persisted"),
	});

	await armFailure(page, "PUT", "/api/preferences/island-notch-mode");
	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect(page.getByRole("alert")).toContainText(
		"Couldn't save Island setting"
	);
	await expectPreference(page, "island-notch-mode", "true");
	await toggle.click();
	await expectPreference(page, "island-notch-mode", "false");
	await expect(toggle).not.toBeChecked();
	expect(preferenceWrites(await readProof(page), "island-notch-mode")).toEqual([
		preferenceWrite("island-notch-mode", "true"),
		preferenceWrite("island-notch-mode", "false", 503),
		preferenceWrite("island-notch-mode", "false"),
	]);
	const notchRequests = (await readProof(page)).requests.filter((request) =>
		request.path.endsWith("/island-notch-mode")
	);
	expectNodeAuthorization(notchRequests);
});
