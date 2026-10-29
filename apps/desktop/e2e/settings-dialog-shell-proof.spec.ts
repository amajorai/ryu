import { expect, type Locator, type Page, test } from "@playwright/test";
import type { InvokeArgs } from "@tauri-apps/api/core";

declare global {
	interface Window {
		__settingsDialogShellApiCalls: Array<{
			method: string;
			path: string;
		}>;
		__settingsDialogShellTauriCalls?: Array<{
			args: InvokeArgs | undefined;
			command: string;
		}>;
	}
}

test.describe.configure({ timeout: 120_000 });

const STORY_URL = "/settings-dialog-shell-proof.html";
const SECTION_CONTENT: [string, string][] = [
	["General", "On startup"],
	["Appearance", "Theme"],
	["Keyboard Shortcuts", "Reset all to defaults"],
	["Voice", "Voice mode display"],
	["Account", "Sign-in & security"],
	["Sessions & devices", "Active sessions"],
	["Ryu apps", "No marketplace Ryu apps are installed on this node."],
	["OAuth apps", "Authorized OAuth Apps"],
	["Billing", "Automatic recharge"],
	["Referrals", "Your invite pass"],
	["Teams", "Teams is an organization plan."],
	["Credits", "No activity yet. Top up to add credits."],
	["Usage", "No usage yet"],
	["Updates", "Check for updates"],
	["Developer", "Developer Mode"],
	["Settings Sync", "Sync My Settings Across Machines"],
];

function dialogFor(page: Page) {
	return page.locator('[data-slot="dialog-content"]').first();
}

async function openSettings(page: Page) {
	await page.route("http://localhost:3000/api/auth/get-session**", (route) =>
		route.fulfill({
			body: JSON.stringify({
				session: {
					createdAt: "2026-09-28T00:00:00.000Z",
					expiresAt: "2030-01-01T00:00:00.000Z",
					id: "settings-shell-session",
					userId: "settings-shell-user",
				},
				user: {
					createdAt: "2026-09-28T00:00:00.000Z",
					email: "ada@example.test",
					emailVerified: true,
					id: "settings-shell-user",
					name: "Ada Lovelace",
					updatedAt: "2026-09-28T00:00:00.000Z",
				},
			}),
			contentType: "application/json",
			status: 200,
		})
	);
	await page.goto(STORY_URL);
	await page.waitForLoadState("networkidle");
	await expect(page.getByTestId("settings-shell-open")).toBeVisible();
	await page.getByTestId("settings-shell-open").click();
	const dialog = dialogFor(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.locator("h2").first()).toHaveText("General");
	return dialog;
}

async function settingsFailureDetails(page: Page, browserErrors: string[]) {
	// Read the current DOM immediately: missing crash/reload markers must never
	// turn the original failure into another locator timeout.
	const snapshot = await page
		.evaluate(() => ({
			url: location.href,
			openState:
				document.querySelector('[data-testid="settings-shell-open-state"]')
					?.textContent ?? "missing",
			heading:
				document.querySelector('[data-slot="dialog-content"] h2')
					?.textContent ?? "missing",
			openChange: document.body?.dataset.settingsDialogOpenChange ?? "missing",
			body: document.body?.innerText.slice(0, 600) ?? "missing",
			apiCalls: window.__settingsDialogShellApiCalls ?? [],
		}))
		.catch((error: Error) => ({ diagnosticError: error.message }));
	return JSON.stringify({ browserErrors, snapshot });
}

async function waitForScrollToSettle(scrollable: Locator) {
	await scrollable.evaluate(
		(element) =>
			new Promise<void>((resolve) => {
				let previousTop = element.scrollTop;
				let stableFrames = 0;
				const deadline = performance.now() + 2500;
				const sample = () => {
					const nextTop = element.scrollTop;
					stableFrames =
						Math.abs(nextTop - previousTop) < 0.5 ? stableFrames + 1 : 0;
					previousTop = nextTop;
					if (stableFrames >= 8 || performance.now() >= deadline) {
						resolve();
						return;
					}
					requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			})
	);
}

test("dialog lifecycle and every desktop settings section render their owned content", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("requestfailed", (request) => {
		browserErrors.push(
			`${request.url()} ${request.failure()?.errorText ?? "request failed"}`
		);
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	const dialog = await openSettings(page);
	await expect(page.getByTestId("settings-shell-open-state")).toHaveText(
		"open"
	);
	await dialog.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("settings-dialog-shell-general.png"),
	});
	if (!(await dialog.isVisible())) {
		throw new Error(
			`Settings closed after initial screenshot; ${await settingsFailureDetails(page, browserErrors)}`
		);
	}

	for (const [section, contentMarker] of SECTION_CONTENT) {
		const navigation = dialog.getByRole("button", {
			name: section,
			exact: true,
		});
		if (!(await navigation.isVisible())) {
			throw new Error(
				`Section navigation ${section} is missing; ${await settingsFailureDetails(page, browserErrors)}`
			);
		}
		await navigation.click();
		if (!(await dialog.isVisible())) {
			throw new Error(
				`Settings closed while opening ${section}; ${await settingsFailureDetails(page, browserErrors)}`
			);
		}
		await expect(dialog.locator("h2").first()).toHaveText(section);
		await expect(
			dialog.getByText(contentMarker, { exact: false }).first()
		).toBeVisible();

		if (section === "Referrals") {
			// The invite pass masks the referral code until it is revealed on
			// purpose; the fixture's code must not be on screen before that.
			await expect(dialog.getByText("LOCAL7", { exact: true })).toHaveCount(0);
			await dialog
				.getByRole("button", {
					name: "Reveal referral code and QR",
					exact: true,
				})
				.click();
			await expect(dialog.getByText("LOCAL7", { exact: true })).toBeVisible();
			await expect(dialog.getByText(/Invited by Ada Lovelace/)).toBeVisible();
			await dialog.screenshot({
				animations: "disabled",
				path: testInfo.outputPath("settings-dialog-shell-referrals.png"),
			});
		}
	}

	await dialog.getByRole("button", { name: "General", exact: true }).click();
	await dialog
		.getByRole("button", { name: "Open Keyboard Shortcuts", exact: true })
		.click();
	await expect(dialog.locator("h2").first()).toHaveText("Keyboard Shortcuts");
	await expect(dialog.getByTestId("keyboard-shortcuts-filter")).toBeVisible();

	await dialog.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("settings-dialog-shell-keyboard-shortcuts.png"),
	});
	await dialog.getByRole("button", { name: "Voice", exact: true }).click({
		timeout: 5000,
	});
	await dialog
		.getByRole("button", { name: "Open Keyboard Shortcuts", exact: true })
		.click();
	await expect(dialog.locator("h2").first()).toHaveText("Keyboard Shortcuts");
	await expect(dialog.getByTestId("keyboard-shortcuts-filter")).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(page.getByTestId("settings-shell-open-state")).toHaveText(
		"closed"
	);
	await page.getByTestId("settings-shell-open").click();
	await expect(dialog).toBeVisible();
	await expect(dialog.locator("h2").first()).toHaveText("General");

	await page.evaluate(() => {
		window.__settingsDialogShellTauriCalls = [];
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke: async (command: string, args: InvokeArgs | undefined) => {
					window.__settingsDialogShellTauriCalls?.push({ command, args });
					return undefined;
				},
				transformCallback: () => 0,
			},
		});
	});
	await dialog
		.getByRole("button", { name: "Send feedback", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => window.__settingsDialogShellTauriCalls))
		.toEqual([
			{
				args: { url: "https://ryuhq.userjot.com/" },
				command: "open_external",
			},
		]);
	await page.evaluate(() =>
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
	);

	await dialog
		.getByRole("button", { name: /^(Gateway|Device) settings$/ })
		.click();
	await expect(page.getByTestId("settings-shell-open-state")).toHaveText(
		"closed"
	);
	const gatewayDialog = dialogFor(page);
	await expect(gatewayDialog).toBeVisible();
	await expect(gatewayDialog.locator("h2").first()).toHaveText("Overview");
	await gatewayDialog.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("settings-dialog-shell-gateway-overview.png"),
	});
	await page.keyboard.press("Escape");
	await expect(gatewayDialog).not.toBeVisible();

	const actionWrites = await page.evaluate(() =>
		window.__settingsDialogShellApiCalls.filter(
			({ method, path }) =>
				method !== "GET" &&
				(/^\/api\/(affiliate|credits|pi-config|sessions|oauth)/.test(path) ||
					/\/checkout(?:\/|$)/.test(path))
		)
	);
	expect(
		actionWrites,
		"navigation must not start payout, credit, provider, session, or OAuth actions"
	).toEqual([]);
	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});

test("settings search routes to a tab and opens the hidden page containing the selected row", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	const dialog = await openSettings(page);
	const search = dialog.getByRole("textbox").first();

	await search.fill("Billing");
	const billingSection = dialog
		.getByRole("button", {
			name: "Billing",
			exact: true,
		})
		.first();
	await expect(billingSection).toBeVisible();
	await billingSection.click();
	if (!(await dialog.isVisible())) {
		throw new Error(
			`Settings closed after choosing Billing; open state=${await page.getByTestId("settings-shell-open-state").innerText()}; browser errors=${browserErrors.join(" | ")}; page=${(await page.locator("body").innerText()).slice(0, 600)}`
		);
	}
	await expect(dialog.locator("h2").first()).toHaveText("Billing");
	await expect(
		dialog.getByRole("heading", { name: "Automatic recharge", exact: true })
	).toBeVisible();

	await search.fill("Theme mode");
	const result = dialog.getByRole("button", { name: /Theme mode/ });
	await expect(result).toBeVisible();
	await result.click();
	await expect(dialog.locator("h2").first()).toHaveText("Appearance");
	await expect(
		dialog.getByRole("heading", { name: "Diff viewer", exact: true }).first()
	).toBeVisible();
	await expect(dialog.getByText("Theme mode", { exact: true })).toBeVisible();
	await expect(search).toHaveValue("");
	await waitForScrollToSettle(
		dialog.locator(".scroll-fade.overflow-y-auto").last()
	);

	await search.fill("Open with");
	const openWithResult = dialog.getByRole("button", { name: /Open with/ });
	await expect(openWithResult).toBeVisible();
	await openWithResult.click();
	await expect(dialog.locator("h2").first()).toHaveText("General");
	await expect(dialog.getByText("Open with", { exact: true })).toBeVisible();
	await expect(search).toHaveValue("");
	await waitForScrollToSettle(
		dialog.locator(".scroll-fade.overflow-y-auto").last()
	);
	await dialog.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("settings-dialog-shell-search-reveal.png"),
	});
});

test("appearance theme changes persist after closing and reopening Settings", async ({
	page,
}, testInfo) => {
	const dialog = await openSettings(page);
	await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
	await expect(dialog.locator("h2").first()).toHaveText("Appearance");
	await dialog.screenshot({
		animations: "disabled",
		path: testInfo.outputPath(
			"settings-dialog-shell-appearance-before-state-change.png"
		),
	});

	const darkTheme = dialog.locator('input[name="theme"][value="dark"]');
	await expect(darkTheme).toHaveCount(1);
	const darkPreview = dialog.locator('img[alt="Dark"]');
	await expect
		.poll(() =>
			darkPreview.evaluate((image) => {
				if (!(image instanceof HTMLImageElement)) {
					throw new Error("Dark theme preview must be a native image");
				}
				return image.naturalWidth;
			})
		)
		.toBeGreaterThan(0);
	await darkTheme.check({ force: true });
	await expect(darkTheme).toBeChecked();
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("dark");
	await dialog.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("settings-dialog-shell-appearance-dark.png"),
	});

	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await page.getByTestId("settings-shell-open").click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
	await expect(
		dialog.locator('input[name="theme"][value="dark"]')
	).toBeChecked();
	await expect(page.locator("html")).toHaveClass(/dark/);
});
