import path from "node:path";
import { expect, test } from "@playwright/test";

const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const PROOF_SCREENSHOT = path.join(
	EVIDENCE_DIR,
	"desktop-os-launcher-coverage.png"
);
const DOCK_SCREENSHOT = path.join(EVIDENCE_DIR, "desktop-os-dock-coverage.png");
const MENUBAR_SCREENSHOT = path.join(
	EVIDENCE_DIR,
	"desktop-os-menubar-coverage.png"
);
const DESKTOP_SCREENSHOT = path.join(
	EVIDENCE_DIR,
	"desktop-os-workspace-coverage.png"
);
const TOOLS_WINDOW_SCREENSHOT = path.join(
	EVIDENCE_DIR,
	"desktop-os-tools-window-coverage.png"
);
const OS_DOCK_ICON_COUNT = 8;

test("opens Apps as live windows from the OS dock and App Launcher", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/os-desktop-surface-proof.html");
	await page.waitForTimeout(2500);

	await expect(page.getByTestId("ryu-os-desktop")).toBeVisible();
	await expect(page.getByTestId("ryu-os-dock")).toBeVisible();
	await expect(page.getByTestId("ryu-os-menubar")).toHaveClass(
		/\bbg-transparent\b/
	);
	await expect(page.locator('[data-tauri-drag-region="true"]')).not.toHaveClass(
		/\bborder-b\b/
	);
	await expect(page.locator('[data-slot="menubar-trigger"]')).toHaveCount(3);
	await expect(
		page.locator('[data-slot="menubar-trigger"]').first()
	).toHaveClass(/\bbg-transparent\b/);
	await expect(page.getByTestId("os-dock-app-launcher")).toBeVisible();
	const dockItems = page.locator('[data-testid^="os-dock-"]');
	for (let index = 0; index < OS_DOCK_ICON_COUNT; index++) {
		const itemBox = await dockItems.nth(index).boundingBox();
		const iconBox = await dockItems
			.nth(index)
			.locator(":scope > div")
			.first()
			.boundingBox();
		expect(itemBox).not.toBeNull();
		expect(iconBox).not.toBeNull();
		if (!(itemBox && iconBox)) {
			continue;
		}
		expect(Math.abs(itemBox.width - itemBox.height)).toBeLessThan(1);
		expect(
			Math.abs(itemBox.x + itemBox.width / 2 - (iconBox.x + iconBox.width / 2))
		).toBeLessThan(1);
		expect(
			Math.abs(
				itemBox.y + itemBox.height / 2 - (iconBox.y + iconBox.height / 2)
			)
		).toBeLessThan(1);
	}
	await expect(dockItems).toHaveCount(OS_DOCK_ICON_COUNT);
	for (let index = 0; index < OS_DOCK_ICON_COUNT; index++) {
		await expect(
			dockItems
				.nth(index)
				.locator('svg, img, [style*="mask-image"], [data-app-icon]')
		).not.toHaveCount(0);
	}
	await expect(page.getByTestId("os-window-window-chat")).toBeVisible();
	await expect(page.getByTestId("os-window-window-spaces")).toHaveCount(1);
	const chatWindow = page.getByTestId("os-window-window-chat");
	const spacesWindow = page.getByTestId("os-window-window-spaces");
	await expect(
		page.getByTestId("os-window-window-chat-minimize")
	).toBeVisible();
	await expect(
		page.getByTestId("os-window-window-chat-maximize")
	).toBeVisible();
	await expect(page.getByTestId("os-window-window-chat-close")).toBeVisible();
	await page.getByTestId("os-window-window-chat-maximize").click();
	await expect(chatWindow).toHaveAttribute("data-maximized", "true");
	await expect(
		page.getByRole("button", { name: "Restore Chat" })
	).toBeVisible();
	await page.getByTestId("os-window-window-chat-maximize").click();
	await expect(chatWindow).toHaveAttribute("data-maximized", "false");
	await page.getByTestId("os-window-window-chat-minimize").click();
	await expect(chatWindow).toBeHidden();
	await expect(spacesWindow).toBeVisible();
	await page.getByTestId("os-dock-app-launcher").click();
	await expect(
		page.getByTestId("app-launcher-window-window-chat")
	).toBeVisible();
	await page.getByTestId("app-launcher-window-window-chat").click();
	await expect(chatWindow).toBeVisible();
	await expect(spacesWindow).toBeHidden();
	await page.getByTestId("os-dock-spaces").click();
	await expect(spacesWindow).toBeVisible();
	await expect(chatWindow).toBeHidden();
	await page.getByTestId("os-dock-chat").click();
	await expect(chatWindow).toBeVisible();
	await expect(spacesWindow).toBeHidden();
	const appLauncherDockItem = page.getByTestId("os-dock-app-launcher");
	const initialDockWidth = Number.parseFloat(
		(await appLauncherDockItem.getAttribute("style"))?.match(
			/width:\s*([\d.]+)px/
		)?.[1] ?? "0"
	);
	await appLauncherDockItem.hover();
	await expect
		.poll(async () =>
			Number.parseFloat(
				(await appLauncherDockItem.getAttribute("style"))?.match(
					/width:\s*([\d.]+)px/
				)?.[1] ?? "0"
			)
		)
		.toBeGreaterThan(initialDockWidth);
	await page.screenshot({ path: DOCK_SCREENSHOT, fullPage: true });
	await page.mouse.move(20, 120);
	await page.screenshot({
		path: DESKTOP_SCREENSHOT,
		fullPage: true,
	});
	const wallpaper = page.locator("[data-wallpaper-id]");
	const initialWallpaper = await wallpaper.getAttribute("data-wallpaper-id");
	await page.getByTestId("os-wallpaper-shuffle").click();
	await expect(wallpaper).not.toHaveAttribute(
		"data-wallpaper-id",
		initialWallpaper ?? ""
	);

	await page.getByTestId("os-dock-app-launcher").click();
	await expect(page.getByText("App Launcher").last()).toBeVisible();
	await expect(page.getByTestId("app-launcher-app-tools")).toBeVisible();
	await expect(page.getByTestId("app-launcher-app-chat")).toHaveAttribute(
		"data-open",
		"true"
	);
	await expect(page.getByTestId("app-launcher-app-tools")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect(
		page.getByTestId("app-launcher-app-mission-control")
	).toBeVisible();
	await expect(
		page.getByTestId("app-launcher-app-app__activity")
	).toBeVisible();
	const appGrid = page.getByTestId("app-launcher-app-grid");
	await expect(appGrid).toHaveCSS("display", "grid");
	const appTiles = appGrid.locator('[data-slot="command-item"]');
	await expect(appTiles).toHaveCount(8);
	const firstTile = await appTiles.nth(0).boundingBox();
	const secondTile = await appTiles.nth(1).boundingBox();
	expect(firstTile).not.toBeNull();
	expect(secondTile).not.toBeNull();
	if (firstTile && secondTile) {
		expect(secondTile.x).toBeGreaterThan(firstTile.x);
		expect(Math.abs(secondTile.y - firstTile.y)).toBeLessThan(1);
	}
	await expect(
		page.getByTestId("app-launcher-window-window-spaces")
	).toBeVisible();
	await page.screenshot({ path: PROOF_SCREENSHOT, fullPage: true });
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();

	await page.getByRole("menuitem", { name: "View" }).click();
	await page.getByRole("menuitemradio", { name: "Quiet places" }).click();
	await expect(wallpaper).toHaveAttribute(
		"data-wallpaper-id",
		/deep-forest|golden-trees/
	);
	const selectedQuietWallpaper =
		(await wallpaper.getAttribute("data-wallpaper-id")) ?? "";
	await page.getByRole("menuitem", { name: /Shuffle wallpaper/ }).click();
	await expect(wallpaper).toHaveAttribute(
		"data-wallpaper-id",
		/deep-forest|golden-trees/
	);
	const menuShuffledWallpaper =
		(await wallpaper.getAttribute("data-wallpaper-id")) ?? "";
	expect(menuShuffledWallpaper).not.toBe(selectedQuietWallpaper);
	await page.getByTestId("os-wallpaper-shuffle").click();
	await expect(wallpaper).toHaveAttribute(
		"data-wallpaper-id",
		/deep-forest|golden-trees/
	);
	const toolbarShuffledWallpaper =
		(await wallpaper.getAttribute("data-wallpaper-id")) ?? "";
	expect(toolbarShuffledWallpaper).not.toBe(menuShuffledWallpaper);

	await page.getByRole("menuitem", { name: "View" }).click();
	await page.getByRole("menuitem", { name: "Customize desktop…" }).click();
	const settingsDialog = page.getByRole("dialog");
	const clockSwitch = settingsDialog.getByRole("switch", { name: "Clock" });
	await expect(clockSwitch).toHaveAttribute("aria-checked", "true");
	await clockSwitch.click();
	await expect(clockSwitch).toHaveAttribute("aria-checked", "false");
	expect(
		await page.evaluate(() => localStorage.getItem("ryu:os-home:clock"))
	).toBe("false");
	await page.keyboard.press("Escape");
	await expect(settingsDialog).toBeHidden();
	await page.getByRole("button", { name: "Customize desktop" }).click();
	await expect(
		page.getByRole("dialog").getByRole("switch", { name: "Clock" })
	).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");

	await page.keyboard.press("Escape");
	await page.getByRole("menuitem", { name: "OS" }).click();
	await expect(page.getByTestId("app-launcher-menu-item")).toBeVisible();
	await page.getByTestId("app-launcher-menu-item").click();
	await expect(page.getByText("App Launcher").last()).toBeVisible();
	await page.keyboard.press("Escape");

	await page.getByRole("menuitem", { name: "Window" }).click();
	await expect(page.getByTestId("app-launcher-trigger")).toBeVisible();
	await page.screenshot({ path: MENUBAR_SCREENSHOT, fullPage: true });
	await page
		.getByRole("menu")
		.getByRole("menuitem", { name: "Spaces" })
		.click();
	await expect(spacesWindow).toBeVisible();
	await expect(chatWindow).toBeHidden();
	await page.getByRole("menuitem", { name: "Window" }).click();
	await page.getByTestId("app-launcher-trigger").click();
	await expect(page.getByText("App Launcher").last()).toBeVisible();
	await page.keyboard.press("Escape");

	await page.getByTestId("os-dock-app-launcher").click();
	await expect(page.getByTestId("app-launcher-app-tools")).toBeVisible();
	await page.getByTestId("app-launcher-app-tools").click();
	await expect(page.getByTestId("os-window-window-tools")).toBeVisible();
	await expect(page.getByTestId("os-window-window-chat")).toBeHidden();

	await page.screenshot({
		path: TOOLS_WINDOW_SCREENSHOT,
		fullPage: true,
	});
	await page.getByTestId("os-window-window-tools-close").click();
	await expect(page.getByTestId("os-window-window-tools")).toBeHidden();
	await expect(pageErrors).toEqual([]);
});
