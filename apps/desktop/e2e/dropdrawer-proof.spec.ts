import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/dropdrawer-proof.html";
const PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/dropdrawer"
);

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async () => {
	await mkdir(PROOF_DIR, { recursive: true });
});

test("DropDrawer and existing dropdown menus stay positioned on wide screens", async ({
	page,
}) => {
	await page.setViewportSize({ height: 840, width: 1280 });
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Open preferences" }).click();

	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await expect(menu).not.toHaveAttribute("data-drawer-mode", "true");
	await expect(page.getByRole("menuitem", { name: "Profile" })).toBeVisible();
	await page.screenshot({
		path: path.join(PROOF_DIR, "dropdrawer-desktop-menu.png"),
	});

	await page.getByRole("menuitem", { name: "Profile" }).click();
	await expect(page.getByTestId("action-result")).toHaveText("Profile opened");

	await page.getByRole("button", { name: "Open existing menu" }).click();
	await expect(
		page.getByRole("menuitem", { name: "Legacy action" })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Legacy action" }).click();
	await expect(page.getByTestId("action-result")).toHaveText(
		"Existing menu action"
	);
});

test("mobile menus use a drawer with nested pages, touch rows, and shared state", async ({
	page,
}) => {
	await page.setViewportSize({ height: 844, width: 390 });
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Open preferences" }).click();

	const drawer = page.getByRole("dialog");
	await expect(drawer).toBeVisible();
	const viewportHeight = await page.evaluate(() => window.innerHeight);
	await expect
		.poll(async () => {
			const box = await drawer.boundingBox();
			return box
				? Math.abs(viewportHeight - (box.y + box.height))
				: Number.POSITIVE_INFINITY;
		})
		.toBeLessThan(1);
	await expect(drawer).toHaveAccessibleName("Preferences");
	const menu = drawer.getByRole("menu");
	await expect(menu).toBeVisible();
	await expect(menu).toHaveAttribute("data-drawer-mode", "true");
	const profileAction = page.getByTestId("profile-action");
	const profileBox = await profileAction.boundingBox();
	if (!profileBox) {
		throw new Error("The mobile menu action did not lay out.");
	}
	expect(profileBox.height).toBeGreaterThanOrEqual(44);
	await page.screenshot({
		path: path.join(PROOF_DIR, "dropdrawer-mobile-menu.png"),
	});

	await page.getByRole("menuitem", { name: "Appearance" }).click();
	await expect(
		drawer.locator('[data-slot="dropdown-menu-submenu-title"]')
	).toHaveText("Appearance");
	await expect(page.getByRole("menuitem", { name: "Theme" })).toBeVisible();
	await page.screenshot({
		path: path.join(PROOF_DIR, "dropdrawer-mobile-submenu.png"),
	});

	await page.getByRole("menuitem", { name: "Theme" }).click();
	await expect(
		drawer.locator('[data-slot="dropdown-menu-submenu-title"]')
	).toHaveText("Theme");
	await page.getByRole("menuitemradio", { name: "Dark" }).click();
	await expect(page.getByTestId("theme-value")).toHaveText("dark");
	await expect(drawer).toHaveCount(0);

	await page.getByRole("button", { name: "Open preferences" }).click();
	await page.getByRole("menuitem", { name: "Appearance" }).click();
	await page.getByRole("menuitem", { name: "Theme" }).click();
	await expect(
		page.getByRole("menuitemradio", { name: "Dark" })
	).toHaveAttribute("aria-checked", "true");
	await page.getByRole("menuitem", { name: "Back to previous menu" }).click();
	await expect(
		drawer.locator('[data-slot="dropdown-menu-submenu-title"]')
	).toHaveText("Appearance");
	await page.getByRole("menuitem", { name: "Back to previous menu" }).click();
	await expect(
		page.getByRole("menuitem", { name: "Appearance" })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Appearance" }).click();
	const soundToggle = page.getByRole("menuitemcheckbox", {
		name: "Interaction sounds",
	});
	await soundToggle.click();
	await expect(drawer).toHaveCount(0);
	await expect(page.getByTestId("sound-value")).toHaveText("Off");

	await page.getByRole("button", { name: "Open preferences" }).click();
	await page.getByRole("menuitem", { name: "Appearance" }).click();
	await expect(
		page.getByRole("menuitemcheckbox", { name: "Interaction sounds" })
	).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");
	await expect(drawer).toHaveCount(0);

	await page.getByRole("button", { name: "Open existing menu" }).click();
	const existingMenu = page.getByRole("menu");
	await expect(existingMenu).toHaveAttribute("data-drawer-mode", "true");
	const existingDrawer = page.getByRole("dialog");
	await expect(existingDrawer).toBeVisible();
	await expect(
		existingMenu.getByRole("menuitem", { name: "Legacy action" })
	).toBeVisible();
	const mobileViewportHeight = await page.evaluate(() => window.innerHeight);
	await expect
		.poll(async () => {
			const box = await existingDrawer.boundingBox();
			return box
				? Math.abs(mobileViewportHeight - (box.y + box.height))
				: Number.POSITIVE_INFINITY;
		})
		.toBeLessThan(1);
	await page.screenshot({
		path: path.join(PROOF_DIR, "dropdrawer-existing-menu-mobile.png"),
	});
});
