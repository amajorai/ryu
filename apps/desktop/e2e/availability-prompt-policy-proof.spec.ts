import { expect, type Page, test } from "@playwright/test";
import type { GamingSettings } from "../src/lib/api/presence.ts";

test.describe.configure({ mode: "serial", timeout: 120_000 });

const CORS_HEADERS = {
	"access-control-allow-headers": "*",
	"access-control-allow-methods": "GET, PUT, POST, OPTIONS",
	"access-control-allow-origin": "*",
};

/**
 * Stand in for Core's presence API. `detectedGame` simulates the opt-in game
 * detector; every heartbeat the harness sends is recorded.
 */
async function mockPresence(
	page: Page,
	options: { detectedGame?: string | null } = {}
): Promise<{
	clientIds: Set<string>;
	reports: string[];
	settingsSaves: unknown[];
}> {
	const reports: string[] = [];
	const settingsSaves: unknown[] = [];
	const clientIds = new Set<string>();
	let gamingSettings: GamingSettings = {
		detectionEnabled: Boolean(options.detectedGame),
		extraProcesses: [],
		freeLocalModels: true,
		ignoredProcesses: [],
	};
	await page.route("**/api/presence/gaming", async (route) => {
		const request = route.request();
		if (request.method() === "OPTIONS") {
			await route.fulfill({ headers: CORS_HEADERS, status: 204 });
			return;
		}
		if (request.method() === "PUT") {
			gamingSettings = request.postDataJSON();
			settingsSaves.push(gamingSettings);
		}
		await route.fulfill({
			headers: CORS_HEADERS,
			json: gamingSettings,
		});
	});
	await page.route("**/api/presence", async (route) => {
		const request = route.request();
		if (request.method() === "OPTIONS") {
			await route.fulfill({ headers: CORS_HEADERS, status: 204 });
			return;
		}
		const body = request.method() === "PUT" ? request.postDataJSON() : null;
		const status = body?.status ?? "online";
		if (body) {
			clientIds.add(body.clientId);
		}
		reports.push(status);
		const detected = options.detectedGame
			? { name: options.detectedGame, sinceMs: 0 }
			: null;
		await route.fulfill({
			headers: CORS_HEADERS,
			json: {
				gaming: {
					active: Boolean(detected) || status === "gaming",
					detectedGame: detected,
					modelsPaused: Boolean(detected) || status === "gaming",
					settings: gamingSettings,
				},
				questionsDeferred: Boolean(detected) || status !== "online",
				source: detected ? "game" : "reported",
				status: detected ? "gaming" : status,
			},
		});
	});
	return { clientIds, reports, settingsSaves };
}

test.beforeEach(async ({ page }) => {
	await mockPresence(page);
});

const STORY_URL = "/availability-prompt-policy-story.html";
const PROOF_SCREENSHOT = "e2e/artifacts/availability-prompt-policy-proof.png";
const PRODUCT_PROOF_SCREENSHOT =
	"../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-availability-controls.png";

async function chooseOption(page: Page, triggerId: string, optionName: string) {
	const trigger = page.locator(`#${triggerId}`);
	await expect(trigger).toBeVisible();
	await trigger.click();
	const listboxId = await trigger.getAttribute("aria-controls");
	const listbox = listboxId
		? page.locator(`[id="${listboxId}"]`)
		: page.getByRole("listbox").last();
	await listbox.getByRole("option", { exact: true, name: optionName }).click();
}

async function readAvailabilitySettings(page: Page) {
	return page.evaluate(() => {
		const value = localStorage.getItem("ryu:user-availability");
		return value ? JSON.parse(value) : null;
	});
}

async function installSettingsApiFixtures(page: Page) {
	await page.route("**/api/auth/get-session", async (route) => {
		if (route.request().method() === "OPTIONS") {
			await route.fulfill({
				headers: {
					"access-control-allow-credentials": "true",
					"access-control-allow-headers": "*",
					"access-control-allow-methods":
						"GET, POST, PUT, PATCH, DELETE, OPTIONS",
					"access-control-allow-origin": "http://127.0.0.1:5202",
				},
				status: 204,
			});
			return;
		}
		await route.fulfill({
			body: JSON.stringify({ session: null, user: null }),
			contentType: "application/json",
			headers: {
				"access-control-allow-credentials": "true",
				"access-control-allow-origin": "http://127.0.0.1:5202",
			},
			status: 200,
		});
	});
}

async function openAvailabilitySubmenu(
	page: Page,
	currentStatus: "Online" | "Away" | "Do not disturb"
) {
	await page.getByRole("button", { name: "Desktop user nav" }).click();
	await page
		.getByRole("menuitem", { name: `Online status: ${currentStatus}` })
		.click();
}

test("keeps a pending question in the composer while Online", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	await expect(
		page.getByRole("button", { name: "Availability: Online" })
	).toHaveCount(0);
	await expect(page.getByTestId("availability-status")).toHaveText("online");
	await expect(page.getByTestId("prompt-location")).toHaveText("Composer");
	await expect(page.locator('[data-composer-prompt="question"]')).toBeVisible();
	await expect(page.locator(".an-tool-question")).toHaveCount(0);

	await page.getByRole("button", { name: "Desktop user nav" }).click();
	await expect(
		page.getByRole("menuitem", { name: "Online status: Online" })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Online status: Online" }).click();
	await expect(
		page.getByRole("menuitem", { name: "Do not disturb", exact: true })
	).toBeVisible();
});

test("Away moves the question to the transcript without discarding it", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	await openAvailabilitySubmenu(page, "Online");
	await expect(
		page.getByRole("menuitem", { name: "Online", exact: true })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Away", exact: true }).click();

	await expect(page.getByTestId("availability-status")).toHaveText("away");
	await expect(page.getByTestId("prompt-location")).toHaveText("Transcript");
	await expect(page.getByText("Away mode", { exact: true })).toBeVisible();
	await expect(page.locator('[data-composer-prompt="question"]')).toHaveCount(
		0
	);
	await expect(page.locator(".an-tool-question")).toBeVisible();
});

test("AFK detection returns Online when the window is focused again", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	await expect(page.getByTestId("availability-status")).toHaveText("online");

	await page.evaluate(() => window.dispatchEvent(new Event("blur")));
	await expect(page.getByTestId("availability-status")).toHaveText("away");

	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByTestId("availability-status")).toHaveText("online");
});

test("the configured idle timeout moves Online to Away and activity recovers it", async ({
	page,
}) => {
	await page.clock.install({ time: new Date("2026-09-26T09:00:00.000Z") });
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	await chooseOption(
		page,
		"availability-afk-timeout-select",
		"After 5 minutes"
	);

	await page.clock.fastForward(5 * 60_000 + 1);
	await expect(page.getByTestId("availability-status")).toHaveText("away");
	await expect(
		page.getByText("Currently Away from AFK detection.", { exact: true })
	).toBeVisible();

	await page.evaluate(() => window.dispatchEvent(new Event("pointerdown")));
	await expect(page.getByTestId("availability-status")).toHaveText("online");
	await expect(
		page.getByText("Currently Online by your choice.", { exact: true })
	).toBeVisible();
});

test("the account menu cycles Online, Away, and Do not disturb as manual choices", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	const transitions = [
		{ from: "Online", to: "Away", stored: "away" },
		{ from: "Away", to: "Do not disturb", stored: "do-not-disturb" },
		{ from: "Do not disturb", to: "Online", stored: "online" },
	] as const;

	for (const transition of transitions) {
		await openAvailabilitySubmenu(page, transition.from);
		await page
			.getByRole("menuitem", { exact: true, name: transition.to })
			.click();

		await expect(page.getByTestId("availability-status")).toHaveText(
			transition.stored
		);
		await expect
			.poll(() => readAvailabilitySettings(page))
			.toMatchObject({ manualStatus: transition.stored });

		if (transition.stored === "online") {
			await expect(page.getByTestId("prompt-location")).toHaveText("Composer");
			await expect(
				page.locator('[data-composer-prompt="question"]')
			).toBeVisible();
		} else {
			await expect(page.getByTestId("prompt-location")).toHaveText(
				"Transcript"
			);
			await expect(page.locator(".an-tool-question")).toBeVisible();
			await expect(
				page.locator('[data-composer-prompt="question"]')
			).toHaveCount(0);
		}
	}
});

test("manual status wins over AFK events, and AFK disablement prevents Away", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	await chooseOption(
		page,
		"availability-manual-status-select",
		"Do not disturb"
	);
	await expect(page.getByTestId("availability-status")).toHaveText(
		"do-not-disturb"
	);
	await page.evaluate(() => window.dispatchEvent(new Event("blur")));
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByTestId("availability-status")).toHaveText(
		"do-not-disturb"
	);
	await expect(
		page.getByText("Currently Do not disturb by your choice.", { exact: true })
	).toBeVisible();

	await chooseOption(page, "availability-manual-status-select", "Online");
	await page.evaluate(() => window.dispatchEvent(new Event("blur")));
	await expect(page.getByTestId("availability-status")).toHaveText("away");
	await expect(
		page.getByText("Currently Away from AFK detection.", { exact: true })
	).toBeVisible();

	const afkDetection = page.locator(
		'[data-setting-id="general.chats.afk-detection"] [data-slot="switch"]'
	);
	await afkDetection.click();
	await expect(afkDetection).not.toBeChecked();
	await expect(page.getByTestId("availability-status")).toHaveText("online");
	await page.evaluate(() => window.dispatchEvent(new Event("blur")));
	await expect(page.getByTestId("availability-status")).toHaveText("online");
	await expect
		.poll(() => readAvailabilitySettings(page))
		.toMatchObject({ afkDetectionEnabled: false, manualStatus: "online" });
});

test("timeout choices persist, disable with AFK detection, and reload correctly", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	const timeoutChoices = [
		{ label: "After 5 minutes", value: 5 },
		{ label: "After 10 minutes", value: 10 },
		{ label: "After 15 minutes", value: 15 },
		{ label: "After 30 minutes", value: 30 },
		{ label: "After 1 hour", value: 60 },
	] as const;
	for (const choice of timeoutChoices) {
		await chooseOption(page, "availability-afk-timeout-select", choice.label);
		await expect
			.poll(() => readAvailabilitySettings(page))
			.toMatchObject({ afkTimeoutMinutes: choice.value });
		await expect(
			page.locator("#availability-afk-timeout-select")
		).toContainText(choice.label.replace("After ", ""));
	}

	const afkDetection = page.locator(
		'[data-setting-id="general.chats.afk-detection"] [data-slot="switch"]'
	);
	const timeoutTrigger = page.locator("#availability-afk-timeout-select");
	await expect(afkDetection).toBeChecked();
	await afkDetection.click();
	await expect(afkDetection).not.toBeChecked();
	await expect(timeoutTrigger).toBeDisabled();
	await expect
		.poll(() => readAvailabilitySettings(page))
		.toMatchObject({ afkDetectionEnabled: false, afkTimeoutMinutes: 60 });
	await page.evaluate(() => window.dispatchEvent(new Event("blur")));
	await expect(page.getByTestId("availability-status")).toHaveText("online");

	await afkDetection.click();
	await expect(timeoutTrigger).toBeEnabled();
	await chooseOption(
		page,
		"availability-afk-timeout-select",
		"After 5 minutes"
	);
	await expect
		.poll(() => readAvailabilitySettings(page))
		.toMatchObject({ afkDetectionEnabled: true, afkTimeoutMinutes: 5 });

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("availability-status")).toHaveText("online");
	await expect(afkDetection).toBeChecked();
	await expect(timeoutTrigger).toBeEnabled();
	await expect(timeoutTrigger).toContainText("5 minutes");
	await expect
		.poll(() => readAvailabilitySettings(page))
		.toMatchObject({
			afkDetectionEnabled: true,
			afkTimeoutMinutes: 5,
			manualStatus: "online",
		});
});

test("Availability settings menu opens the real General settings dialog", async ({
	page,
}) => {
	test.setTimeout(30_000);
	const browserErrors: string[] = [];
	page.on("requestfailed", (request) => {
		browserErrors.push(
			`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`
		);
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	await installSettingsApiFixtures(page);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	await openAvailabilitySubmenu(page, "Online");
	await page.getByRole("menuitem", { name: "Availability settings" }).click();
	const settingsDialog = page.getByRole("dialog");
	await expect(settingsDialog).toBeVisible();
	await expect(
		settingsDialog.getByRole("heading", { name: "General" })
	).toBeVisible();
	await expect(
		settingsDialog.getByRole("button", { name: "General" })
	).toBeVisible();
	await settingsDialog.getByText("Chats", { exact: true }).click();
	await expect(
		settingsDialog.getByText("Availability & prompts", { exact: true })
	).toBeVisible();
	await expect(
		settingsDialog.getByText("Auto-away when inactive", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("availability-status")).toHaveText("online");
	await settingsDialog
		.getByText("Availability & prompts", { exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: PRODUCT_PROOF_SCREENSHOT,
	});
	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});

test("an async question stays answerable after the agent moved on", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(`${STORY_URL}?scenario=async`, {
		waitUntil: "domcontentloaded",
	});

	const card = page.locator('[data-composer-prompt="question"]');
	await expect(card).toBeVisible();
	await expect(
		card.getByText("Which theme should the dashboard default to?")
	).toBeVisible();
	await card.getByRole("button", { name: /Light theme/ }).click();
	await card.getByRole("button", { name: "Send", exact: true }).click();

	await expect(page.getByTestId("async-answer")).toContainText(
		"Which theme should the dashboard default to?: Light theme"
	);
	await expect(page.getByTestId("async-answer")).toContainText(
		"ryu-question-answer:ask-async-1"
	);
	await expect(card).toHaveCount(0);
});

test("a detected game switches to Gaming and reports availability to Core", async ({
	page,
}) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
	const presence = await mockPresence(page, { detectedGame: "Hades" });
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	await expect(page.getByTestId("availability-status")).toHaveText("gaming");
	await expect(page.getByText("Gaming mode", { exact: true })).toBeVisible();
	await expect(page.locator('[data-composer-prompt="question"]')).toHaveCount(
		0
	);
	await expect(
		page.getByText("Detected Hades. Ryu is in Gaming mode until it closes.")
	).toBeVisible();
	expect(presence.reports[0]).toBe("online");
	// Each window names itself so Core can merge per-window idle clocks.
	expect(presence.clientIds.size).toBe(1);
	expect([...presence.clientIds][0]).toMatch(/\S{8,}/);

	const freeModels = page.locator(
		'[data-setting-id="general.chats.gaming-free-models"] [data-slot="switch"]'
	);
	await expect(freeModels).toBeChecked();
	await freeModels.click();
	await expect.poll(() => presence.settingsSaves.length).toBe(1);
	expect(presence.settingsSaves[0]).toMatchObject({ freeLocalModels: false });

	// The footer shows availability only as the avatar dot; the status and its
	// caption live in the account menu's Online status submenu.
	await page.getByRole("button", { name: "Desktop user nav" }).click();
	await page.getByRole("menuitem", { name: "Online status: Gaming" }).click();
	await expect(page.getByText("Gaming: Hades is running")).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: "e2e/artifacts/availability-gaming-proof.png",
	});
});

test("status and AFK preferences persist and the final product proof is captured", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	await openAvailabilitySubmenu(page, "Online");
	await page.getByRole("menuitem", { name: "Away", exact: true }).click();
	await expect(page.getByTestId("availability-status")).toHaveText("away");
	const afkDetection = page.locator(
		'[data-setting-id="general.chats.afk-detection"] [data-slot="switch"]'
	);
	await expect(afkDetection).toBeChecked();
	await afkDetection.click();
	await expect(afkDetection).not.toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:user-availability"))
		)
		.toContain('"afkDetectionEnabled":false');

	await openAvailabilitySubmenu(page, "Away");
	await expect(
		page.getByRole("menuitem", { name: "Do not disturb", exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: PROOF_SCREENSHOT,
	});
	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});
