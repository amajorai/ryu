import { expect, test } from "@playwright/test";

const STORY_URL = "/desktop-menu-parity-proof.html";
const standardDestinations = [
	{ label: "Profile", path: "/u/demo-user" },
	{ label: "Organizations", path: "/organizations" },
	{ label: "Invite a friend", path: "/referrals" },
	{ label: "Join Discord", path: "/discord" },
	{ label: "Account", path: "/settings" },
	{ label: "Personal access tokens", path: "/api-keys" },
] as const;

const botDestinations = [
	{ label: "Account", path: "/settings" },
	{ label: "Organizations", path: "/organizations" },
	{ label: "Join Discord", path: "/discord" },
	{ label: "Download Ryu Build", path: "/download" },
] as const;

async function openThemeSubmenu(page: import("@playwright/test").Page) {
	await page.getByRole("button", { name: "Desktop user nav" }).click();
	await page.getByRole("menuitem", { name: "Theme", exact: true }).hover();
	for (const label of ["Light", "Dark", "System"]) {
		await expect(
			page.getByRole("menuitem", { name: label, exact: true })
		).toBeVisible();
	}
}

async function selectTheme(
	page: import("@playwright/test").Page,
	label: "Dark" | "Light" | "System"
) {
	await openThemeSubmenu(page);
	await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function expectTheme(
	page: import("@playwright/test").Page,
	theme: "dark" | "light" | "system",
	resolvedTheme: "dark" | "light",
	storedTheme: string | null = theme
) {
	const themeState = page.getByTestId("theme-mode");
	await expect(themeState).toHaveAttribute("data-theme", theme);
	await expect(themeState).toHaveAttribute(
		"data-resolved-theme",
		resolvedTheme
	);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("ryu-desktop-menu-parity-proof-theme")
		)
	).toBe(storedTheme);
	expect(
		await page.evaluate(() =>
			document.documentElement.classList.contains("dark")
		)
	).toBe(resolvedTheme === "dark");
}

test("standard account links report all six production destinations", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ height: 980, width: 1440 });
	await page.goto(STORY_URL);
	await expect(page.getByTestId("proof-status")).toHaveText(
		"Production components mounted"
	);

	const openedPaths: string[] = [];
	for (const [index, destination] of standardDestinations.entries()) {
		await page.getByRole("button", { name: "Desktop user nav" }).click();
		const item = page.getByRole("menuitem", {
			name: destination.label,
			exact: true,
		});
		if (index === 0) {
			await expect(page.getByRole("menuitem")).toHaveCount(7);
		}
		await expect(item).toBeVisible();
		if (index === 0) {
			await page.screenshot({
				fullPage: true,
				path: testInfo.outputPath("desktop-web-account-links-standard.png"),
			});
		}
		await item.click();
		openedPaths.push(destination.path);
		await expect(page.getByTestId("standard-opened-paths")).toHaveText(
			JSON.stringify(openedPaths)
		);
	}
});

test("bot-product account links report all four production destinations", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ height: 980, width: 1440 });
	await page.goto(STORY_URL);

	const openedPaths: string[] = [];
	for (const [index, destination] of botDestinations.entries()) {
		await page.getByRole("button", { name: "Bot product user nav" }).click();
		const item = page.getByRole("menuitem", {
			name: destination.label,
			exact: true,
		});
		if (index === 0) {
			await expect(page.getByRole("menuitem")).toHaveCount(4);
		}
		await expect(item).toBeVisible();
		if (index === 0) {
			await page.screenshot({
				fullPage: true,
				path: testInfo.outputPath("desktop-web-account-links-bot.png"),
			});
		}
		await item.click();
		openedPaths.push(destination.path);
		await expect(page.getByTestId("bot-opened-paths")).toHaveText(
			JSON.stringify(openedPaths)
		);
	}
});

test("Light, Dark, and System themes update the DOM and persist across reload", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ height: 980, width: 1440 });
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto(STORY_URL);
	await expectTheme(page, "light", "light", null);

	await openThemeSubmenu(page);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("desktop-theme-submenu.png"),
	});
	await page.getByRole("menuitem", { name: "Dark", exact: true }).click();
	await expectTheme(page, "dark", "dark");

	await selectTheme(page, "Light");
	await expectTheme(page, "light", "light");

	await selectTheme(page, "System");
	await expectTheme(page, "system", "dark");

	await page.emulateMedia({ colorScheme: "light" });
	await expectTheme(page, "system", "light");
	await page.reload();
	await expectTheme(page, "system", "light");
});

test("switches the desktop theme with the Classic toggle", async ({
	page,
}, testInfo) => {
	await page.goto("/desktop-menu-parity-proof.html");
	await expectTheme(page, "light", "light", null);

	await page.getByRole("button", { name: "Desktop user nav" }).click();
	await page.getByRole("menuitem", { name: "Theme", exact: true }).hover();
	await expect(
		page.getByRole("menuitem", { name: "Dark", exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("desktop-light.png"),
	});

	await page.getByRole("menuitem", { name: "Dark", exact: true }).click();
	await expectTheme(page, "dark", "dark");
	await expect(page.locator("html")).toHaveClass(/dark/);

	await page.getByRole("button", { name: "Desktop user nav" }).click();
	await page.getByRole("menuitem", { name: "Theme", exact: true }).hover();
	await expect(
		page.getByRole("menuitem", { name: "Light", exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("desktop-dark.png"),
	});
});
