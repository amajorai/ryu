import { expect, test } from "@playwright/test";

test("Account Settings keeps its shared tabs visible", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 980, height: 600 });
	await page.goto("/sticky-settings-proof.html");
	await expect(
		page.getByRole("heading", { name: "Account Settings" })
	).toBeVisible();
	await page.getByRole("main").evaluate((element) => {
		element.scrollTop = 500;
	});
	await expect
		.poll(
			async () =>
				(await page.locator('[data-slot="tabs-list-sticky"]').boundingBox())?.y
		)
		.toBe(0);
	await page.screenshot({
		path: testInfo.outputPath("account-settings-pinned.png"),
	});
	expect(errors).toEqual([]);
});

for (const mode of ["managed", "scroll"]) {
	for (const dark of [false, true]) {
		test(`${mode} tabs stay pinned and interactive in ${dark ? "dark" : "light"}`, async ({
			page,
		}, testInfo) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") {
					errors.push(message.text());
				}
			});
			await page.setViewportSize({ width: 980, height: 650 });
			await page.goto(
				`/sticky-tabs-proof.html?mode=${mode}${dark ? "&dark" : ""}`
			);
			const scroller = page.getByTestId("scroll-area");
			const sticky = page.locator('[data-slot="tabs-list-sticky"]');
			await expect(sticky).toHaveCSS("position", "sticky");
			const before = await sticky.boundingBox();
			expect(before?.y).toBeGreaterThan(70);
			await page.mouse.move(600, 500);
			await page.mouse.wheel(0, 650);
			await expect
				.poll(() => scroller.evaluate((element) => element.scrollTop))
				.toBeGreaterThan(500);
			await expect.poll(async () => (await sticky.boundingBox())?.y).toBe(0);
			await expect(sticky).not.toHaveCSS(
				"background-color",
				"rgba(0, 0, 0, 0)"
			);
			const fade = sticky.locator('[data-slot="tabs-list-fade"]');
			await expect(fade).toHaveCSS("pointer-events", "none");
			await expect(fade).toHaveCSS("background-image", /linear-gradient/);
			await expect(fade).toHaveAttribute("aria-hidden", "true");
			const stickyBox = await sticky.boundingBox();
			const fadeBox = await fade.boundingBox();
			expect(stickyBox).not.toBeNull();
			expect(fadeBox).not.toBeNull();
			if (stickyBox && fadeBox) {
				expect(fadeBox.height).toBeGreaterThan(0);
				expect(fadeBox.y).toBeCloseTo(stickyBox.y + stickyBox.height);
				expect(fadeBox.width).toBeCloseTo(stickyBox.width);
			}
			const account = page.getByRole("tab", { name: "Account", exact: true });
			await account.click();
			await expect(account).toHaveAttribute("aria-selected", "true");
			await account.press("ArrowRight");
			await expect(
				page.getByRole("tab", { name: "Notifications", exact: true })
			).toBeFocused();
			await page.mouse.move(600, 500);
			await scroller.evaluate((element) => {
				element.scrollTop = 650;
			});
			await expect.poll(async () => (await sticky.boundingBox())?.y).toBe(0);
			await page.screenshot({
				path: testInfo.outputPath("settings-tabs-pinned.png"),
			});
			await page.setViewportSize({ width: 390, height: 650 });
			// Below md the same tabs pin to the bottom, with the fade above them.
			await expect
				.poll(async () => {
					const box = await sticky.boundingBox();
					return box ? box.y + box.height : null;
				})
				.toBe(650);
			const mobileStickyBox = await sticky.boundingBox();
			const mobileFadeBox = await fade.boundingBox();
			expect(mobileStickyBox).not.toBeNull();
			expect(mobileFadeBox).not.toBeNull();
			if (mobileStickyBox && mobileFadeBox) {
				// Absolute bottom-full anchors to the containing padding box,
				// immediately inside the mobile strip's top border.
				await expect(sticky).toHaveCSS("border-top-width", "1px");
				const borderTopWidth = await sticky.evaluate((element) =>
					Number.parseFloat(getComputedStyle(element).borderTopWidth)
				);
				expect(mobileFadeBox.y + mobileFadeBox.height).toBeCloseTo(
					mobileStickyBox.y + borderTopWidth
				);
				expect(mobileFadeBox.width).toBeCloseTo(mobileStickyBox.width);
			}
			if (mode === "managed") {
				await page.locator('[data-tabs-more-trigger="true"]').click();
				await expect(
					page.getByRole("combobox", { name: "Search tabs" })
				).toBeVisible();
				await page
					.getByRole("combobox", { name: "Search tabs" })
					.fill("Support Access");
				await page
					.locator("[data-tabs-menu-key]")
					.filter({ hasText: "Support Access" })
					.click();
				await expect(
					page.getByRole("tab", { name: "Support Access", exact: true })
				).toHaveAttribute("aria-selected", "true");
			} else {
				await page.getByRole("tablist").hover();
				const right = page.getByRole("button", { name: "Scroll tabs right" });
				await expect(right).toBeVisible();
				await right.click();
				await expect
					.poll(() =>
						page.getByRole("tablist").evaluate((element) => element.scrollLeft)
					)
					.toBeGreaterThan(0);
			}
			await page.keyboard.press("Escape");
			await page.mouse.move(350, 500);
			await page.screenshot({
				path: testInfo.outputPath("settings-tabs-mobile.png"),
			});
			await scroller.evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			await expect
				.poll(async () => (await sticky.boundingBox())?.y ?? 0)
				.toBeLessThan(0);
			expect(errors).toEqual([]);
		});
	}
}

test("offset leaves room for the fixed header", async ({ page }) => {
	await page.goto("/sticky-tabs-proof.html?offset");
	await page.getByTestId("scroll-area").evaluate((element) => {
		element.scrollTop = 600;
	});
	await expect
		.poll(
			async () =>
				(await page.locator('[data-slot="tabs-list-sticky"]').boundingBox())?.y
		)
		.toBe(48);
});

for (const mode of ["plain", "vertical"]) {
	test(`${mode} tabs keep their normal layout`, async ({ page }) => {
		await page.goto(`/sticky-tabs-proof.html?mode=${mode}`);
		await expect(page.locator('[data-slot="tabs-list-sticky"]')).toHaveCount(0);
		await page.getByTestId("scroll-area").evaluate((element) => {
			element.scrollTop = 600;
		});
		await expect
			.poll(async () => (await page.getByRole("tablist").boundingBox())?.y ?? 0)
			.toBeLessThan(0);
	});
}
