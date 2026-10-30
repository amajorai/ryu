import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";
import type { StreamingSettings } from "../src/lib/api/presence.ts";

const streamingSettingsFieldsSchema = z.object({
	apps: z.array(z.string()),
	detectionEnabled: z.boolean(),
	schemaVersion: z.number(),
}) satisfies z.ZodType<StreamingSettings>;
const streamingSettingsSchema = z.custom<StreamingSettings>((value) => {
	const parsed = pluginDocumentSchema.safeParse(value);
	return (
		parsed.success &&
		streamingSettingsFieldsSchema.safeParse(parsed.data).success
	);
});

const STORY_URL = "/desktop-general-settings-proof.html";
const PROOF_SCREENSHOT = resolve(
	process.cwd(),
	"../../target/streaming-mode-proof.png"
);

test("renders Streaming detection settings and persists user app names", async ({
	page,
}) => {
	let streamingSettings: StreamingSettings = {
		apps: ["obs64", "streamlabs", "tiktoklivestudio"],
		detectionEnabled: true,
		schemaVersion: 1,
	};
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.setDefaultTimeout(15_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.addInitScript(() => {
		Object.assign(window, {
			__TAURI_INTERNALS__: {
				invoke: async (command: string) => {
					if (command === "get_default_projectless_task_folder") {
						return "C:\\Users\\Proof\\Documents\\Ryu\\Projects";
					}
					return null;
				},
				transformCallback: () => 1,
			},
		});
	});
	await page.route("**/api/presence/streaming", async (route) => {
		if (route.request().method() === "PUT") {
			streamingSettings = streamingSettingsSchema.parse(
				route.request().postDataJSON()
			);
		}
		await route.fulfill({ json: streamingSettings });
	});
	await page.route("**/api/presence/gaming", async (route) => {
		await route.fulfill({
			json: {
				detectionEnabled: false,
				extraProcesses: [],
				freeLocalModels: true,
				ignoredProcesses: [],
			},
		});
	});
	await page.goto(STORY_URL);
	await expect(
		page.getByTestId("desktop-general-settings-proof")
	).toBeVisible();
	await page.getByText("Chats", { exact: true }).first().click();

	await expect(
		page.getByText("Availability & prompts", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Detect streaming apps", { exact: true })
	).toBeVisible();
	const manualStatus = page.locator(
		'[data-setting-id="general.chats.manual-status"] [data-slot="select-trigger"]'
	);
	await manualStatus.click();
	await page.getByRole("option", { name: "Streaming", exact: true }).click();
	await expect(manualStatus.locator('[data-slot="select-value"]')).toHaveText(
		"Streaming"
	);
	const detectionToggle = page.locator(
		'[data-setting-id="general.chats.streaming-detection"] [data-slot="switch"]'
	);
	await expect(detectionToggle).toBeChecked();
	await detectionToggle.click();
	await expect.poll(() => streamingSettings.detectionEnabled).toBe(false);
	await detectionToggle.click();
	await expect.poll(() => streamingSettings.detectionEnabled).toBe(true);

	const appNames = page.getByRole("textbox", {
		name: "Streaming app process names",
	});
	await appNames.fill("obs64, my-capture-tool");
	await appNames.press("Tab");
	await expect
		.poll(() => streamingSettings.apps)
		.toEqual(["obs64", "my-capture-tool"]);

	await expect(
		page.getByText(
			"Switch to Streaming while a listed app runs. Connect event contents stay out of models.",
			{ exact: true }
		)
	).toBeVisible();
	mkdirSync(dirname(PROOF_SCREENSHOT), { recursive: true });
	await page.screenshot({ fullPage: true, path: PROOF_SCREENSHOT });
	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});
