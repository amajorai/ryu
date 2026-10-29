import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

test("delays the compact cancel action for each desktop sign-in attempt", async ({
	page,
}, testInfo) => {
	await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
	await page.setViewportSize({ height: 900, width: 900 });
	await page.goto("/login-i18n-proof.html");
	await page.clock.pauseAt(new Date("2030-01-01T00:10:00Z"));
	const start = page.getByRole("button", { name: "Comenzar", exact: true });
	const cancel = page.getByRole("button", { name: "Cancelar", exact: true });
	await start.click();
	await expect(cancel).toHaveCount(0);
	await page.clock.runFor(2999);
	await expect(cancel).toHaveCount(0);
	await page.clock.runFor(1);
	await expect(cancel).toBeVisible();
	await expect(cancel).toHaveClass(/hover:bg-muted hover:text-foreground/);
	await expect(cancel).toHaveClass(/h-8/);
	const cancelBox = await cancel.boundingBox();
	const openBox = await page
		.getByRole("button", { name: "Abrir", exact: true })
		.boundingBox();
	expect(cancelBox).not.toBeNull();
	expect(openBox).not.toBeNull();
	if (cancelBox && openBox) {
		expect(cancelBox.width).toBeLessThan(openBox.width / 2);
		expect(
			Math.abs(
				cancelBox.x + cancelBox.width / 2 - openBox.x - openBox.width / 2
			)
		).toBeLessThan(1);
	}
	await page.screenshot({
		path: testInfo.outputPath("desktop-login-cancel.png"),
	});
	await cancel.click();
	await start.click();
	await expect(cancel).toHaveCount(0);
	await page.clock.runFor(3000);
	await expect(cancel).toBeVisible();
});

test("localizes the desktop welcome surface and switches to Arabic RTL", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});

	await page.setViewportSize({ height: 900, width: 900 });
	await page.goto("/login-i18n-proof.html", {
		waitUntil: "domcontentloaded",
	});

	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
	await expect(
		page.getByRole("heading", { name: "Hola, soy Ryu" })
	).toBeVisible();
	await expect(
		page.getByText("Tu fantasma amigable que vive en tu escritorio")
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Comenzar" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Probar Ryu sin una cuenta" })
	).toBeVisible();
	await expect(page.getByTestId("switch-arabic")).toHaveText("Cambiar a árabe");
	await expect(page.getByRole("heading").locator("..")).toHaveCSS(
		"opacity",
		"1"
	);
	await expect(
		page.getByRole("button", { name: "Comenzar" }).locator("..")
	).toHaveCSS("opacity", "1");
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("login-spanish-proof.png"),
	});

	await page.getByTestId("switch-arabic").click();
	await expect(page.locator("html")).toHaveAttribute("lang", "ar");
	await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
	await expect(
		page.getByRole("heading", { name: "مرحبًا، أنا Ryu" })
	).toBeVisible();
	await expect(
		page.getByText("شبحك الودود الذي يعيش على سطح مكتبك")
	).toBeVisible();
	await expect(page.getByRole("button", { name: "البدء" })).toBeVisible();
	await expect(page.getByTestId("switch-arabic")).toHaveText(
		"التبديل إلى العربية"
	);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("login-arabic-proof.png"),
	});

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});
