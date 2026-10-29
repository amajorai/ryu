import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const PROOF_DIR = resolve(
	process.env.RYU_E2E_PROOF_DIR ?? "../../docs/proof/ryu-os"
);
const PROOF_SCREENSHOT = join(PROOF_DIR, "ryu-os-user-navigation-proof.png");
const TRAY_SELECTOR = '.t-morph[data-open="true"] .t-morph-menu';

test("OS keeps compact user navigation visible in its menu bar", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.route("**/api/auth/get-session", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				session: {
					id: "os-proof-session",
					userId: "os-proof-user",
					expiresAt: "2099-01-01T00:00:00.000Z",
				},
				user: {
					id: "os-proof-user",
					name: "Jiawei",
					email: "jiawei@example.test",
					image: null,
				},
			}),
		})
	);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			pageErrors.push(message.text());
		}
	});
	await page.goto("/os-desktop-surface-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(pageErrors).toEqual([]);

	const topbar = page.getByTestId("ryu-os-topbar");
	const navigation = page.getByTestId("ryu-os-user-navigation");
	await expect(topbar)
		.toBeVisible()
		.catch((error: Error) => {
			throw new Error(`OS did not render: ${pageErrors.join("; ")}`, {
				cause: error,
			});
		});
	await expect(navigation).toBeVisible();
	const controls = [
		navigation.getByRole("button", { name: "Account", exact: true }),
		navigation.getByRole("button", { name: "Notifications", exact: true }),
		navigation.getByRole("button", { name: "Downloads", exact: true }),
	];
	const controlBoxes = await Promise.all(
		controls.map(async (control) => {
			await expect(control).toBeVisible();
			return control.boundingBox();
		})
	);
	for (let index = 0; index < controlBoxes.length; index++) {
		const box = controlBoxes[index];
		expect(box).not.toBeNull();
		if (!box) {
			continue;
		}
		expect(box.width).toBeGreaterThanOrEqual(24);
		expect(box.width).toBeLessThanOrEqual(26);
		expect(box.height).toBeGreaterThanOrEqual(24);
		expect(box.height).toBeLessThanOrEqual(26);
		if (index > 0) {
			const previous = controlBoxes[index - 1];
			expect(previous).not.toBeNull();
			if (previous) {
				expect(box.x).toBeGreaterThan(previous.x);
				expect(Math.abs(box.y - previous.y)).toBeLessThan(1);
			}
		}
	}
	const notificationIcon = await controls[1]
		.locator("svg")
		.first()
		.boundingBox();
	expect(notificationIcon).not.toBeNull();
	if (notificationIcon) {
		expect(notificationIcon.width).toBeLessThanOrEqual(16);
		expect(notificationIcon.height).toBeLessThanOrEqual(16);
	}
	await controls[0].click();
	await expect(
		page.getByRole("menuitem", { name: "Settings", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Availability: Online", exact: true })
		.click();
	await expect(
		page.getByRole("menuitem", { name: "Away", exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");

	await page.setViewportSize({ height: 812, width: 320 });
	const narrowNavigation = await navigation.boundingBox();
	expect(narrowNavigation).not.toBeNull();
	if (narrowNavigation) {
		expect(narrowNavigation.x).toBeGreaterThanOrEqual(0);
		expect(narrowNavigation.x + narrowNavigation.width).toBeLessThanOrEqual(
			320
		);
	}
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth
		)
	).toBe(false);
	const narrowTopbarBox = await topbar.boundingBox();
	if (!narrowTopbarBox) {
		throw new Error("OS menu bar has no visible bounds at 320px");
	}
	const narrowMenubarBottom = narrowTopbarBox.y + narrowTopbarBox.height;
	await controls[1].click();
	const narrowNotificationsTray = page.locator(TRAY_SELECTOR);
	await expect(narrowNotificationsTray).toContainText("All caught up");
	await expect
		.poll(async () => (await narrowNotificationsTray.boundingBox())?.y ?? -1)
		.toBeGreaterThanOrEqual(narrowMenubarBottom);
	const narrowTrayBox = await narrowNotificationsTray.boundingBox();
	expect(narrowTrayBox).not.toBeNull();
	if (narrowTrayBox) {
		expect(narrowTrayBox.x).toBeGreaterThanOrEqual(0);
		expect(narrowTrayBox.x + narrowTrayBox.width).toBeLessThanOrEqual(320);
	}
	await page.keyboard.press("Escape");
	await expect(page.locator(TRAY_SELECTOR)).toHaveCount(0);

	await page.setViewportSize({ height: 900, width: 1440 });
	const topbarBox = await topbar.boundingBox();
	if (!topbarBox) {
		throw new Error("OS menu bar has no visible bounds");
	}
	const menubarBottom = topbarBox.y + topbarBox.height;
	await controls[1].click();
	const notificationsTray = page.locator(TRAY_SELECTOR);
	await expect(notificationsTray).toContainText("All caught up");
	await expect
		.poll(async () => (await notificationsTray.boundingBox())?.y ?? -1)
		.toBeGreaterThanOrEqual(menubarBottom);
	const notificationsBox = await notificationsTray.boundingBox();
	expect(notificationsBox).not.toBeNull();
	if (notificationsBox) {
		expect(notificationsBox.x).toBeGreaterThanOrEqual(0);
		expect(notificationsBox.x + notificationsBox.width).toBeLessThanOrEqual(
			1440
		);
	}
	await page.keyboard.press("Escape");
	await expect(page.locator(TRAY_SELECTOR)).toHaveCount(0);

	await controls[2].click();
	const downloadsTray = page.locator(TRAY_SELECTOR);
	await expect(downloadsTray).toContainText("Nothing downloading");
	await expect
		.poll(async () => (await downloadsTray.boundingBox())?.y ?? -1)
		.toBeGreaterThanOrEqual(menubarBottom);
	const downloadsBox = await downloadsTray.boundingBox();
	expect(downloadsBox).not.toBeNull();
	if (downloadsBox) {
		expect(downloadsBox.x).toBeGreaterThanOrEqual(0);
		expect(downloadsBox.x + downloadsBox.width).toBeLessThanOrEqual(1440);
	}
	await page.keyboard.press("Escape");
	for (const panel of await page.locator(".t-morph-menu").all()) {
		await expect(panel).toHaveCSS("opacity", "0");
	}
	await page.mouse.move(720, 450);
	await topbar.click({ position: { x: 700, y: 25 } });
	await expect(
		page.getByRole("tooltip", { name: "Downloads", exact: true })
	).toBeHidden();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
	const chatWindow = page.getByTestId("os-window-window-chat");
	await expect(topbar.getByText("Ready", { exact: true })).toHaveCount(0);
	const statusDot = controls[0].locator(".bg-success");
	await expect(statusDot).toHaveCount(1);
	await expect(navigation.locator(".bg-success")).toHaveCount(1);
	await expect(statusDot).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
	const dotBox = await statusDot.boundingBox();
	const accountBox = await controls[0].boundingBox();
	expect(dotBox).not.toBeNull();
	expect(accountBox).not.toBeNull();
	if (dotBox && accountBox) {
		expect(dotBox.x).toBeGreaterThan(accountBox.x + accountBox.width / 2);
		expect(dotBox.y).toBeGreaterThan(accountBox.y + accountBox.height / 2);
	}
	await expect(chatWindow.locator("header")).toHaveCSS(
		"border-bottom-width",
		"0px"
	);
	await chatWindow
		.getByRole("button", { name: "Maximize Chat", exact: true })
		.click();
	await expect(chatWindow).toHaveAttribute("data-maximized", "true");
	await chatWindow
		.getByRole("button", { name: "Restore Chat", exact: true })
		.click();
	await expect(chatWindow).toHaveAttribute("data-maximized", "false");
	await page.mouse.move(720, 450);
	await expect(pageErrors).toEqual([]);
	await page.screenshot({ fullPage: true, path: PROOF_SCREENSHOT });
});
