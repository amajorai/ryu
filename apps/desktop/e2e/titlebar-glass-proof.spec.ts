import { expect, test } from "@playwright/test";

for (const chrome of ["floating", "inset"]) {
	test(`${chrome}: real Vault scrolls under glass, content stays clear, bottom remains reachable`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`/titlebar-glass-proof.html?chrome=${chrome}`);
		const notice = page.getByRole("button", { name: "Got it", exact: true });
		if (await notice.isVisible()) {
			await notice.click();
		}
		const heading = page.getByRole("heading", { name: "Vault", exact: true });
		await expect(heading).toBeVisible();
		const frame = page.locator("[data-titlebar-page]:visible");
		const scroll = frame.locator(".overflow-y-auto").first();
		const bar = page.locator("[data-tab-appearance][data-tauri-drag-region]");
		const glass = bar.locator(":scope > .pointer-events-none").first();
		const inset = await glass.evaluate((el) =>
			Number.parseFloat(getComputedStyle(el).height)
		);
		await expect
			.poll(() =>
				scroll.evaluate((el) =>
					Number.parseFloat(getComputedStyle(el).paddingTop)
				)
			)
			.toBeCloseTo(inset, 1);
		const frameBox = await frame.boundingBox();
		const scrollBox = await scroll.boundingBox();
		expect(Math.abs(scrollBox!.y - frameBox!.y)).toBeLessThan(1);
		expect(Math.abs(scrollBox!.height - frameBox!.height)).toBeLessThan(1);
		expect((await heading.boundingBox())!.y).toBeGreaterThan(
			frameBox!.y + inset
		);
		expect(Math.abs((await glass.boundingBox())!.height - inset)).toBeLessThan(
			1
		);
		await scroll.evaluate((el) => {
			el.scrollTop = 260;
		});
		await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(260);
		// Reconciliation and tab changes must preserve scroll position.
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Settings", exact: true })
		).toBeVisible();
		await page.getByRole("button", { name: "Vault", exact: true }).click();
		await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(260);
		await page.setViewportSize({ width: 1100, height: 760 });
		await expect
			.poll(async () =>
				Math.abs(
					(await scroll.boundingBox())!.height -
						(await frame.boundingBox())!.height
				)
			)
			.toBeLessThan(1);
		await scroll.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect(
			page.getByText("WORKSPACE_TOKEN_24", { exact: true })
		).toBeVisible();
		expect(
			await frame.evaluate((el) => el.scrollHeight - el.clientHeight)
		).toBeLessThanOrEqual(1);
		await scroll.evaluate((el) => {
			el.scrollTop = 260;
		});
		await expect(
			page.getByText("Connection restored", { exact: true })
		).toBeHidden({ timeout: 10_000 });
		await page.screenshot({
			path: `e2e/artifacts/titlebar-glass-${chrome}.png`,
		});
		expect(errors).toEqual([]);
	});
}

test("OS welcome fades, customization persists, and clock ticks", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/titlebar-glass-proof.html?realm=os");
	await expect(page.getByTestId("os-home-clock")).toBeVisible();
	await expect(page.getByTestId("os-home-intro")).toHaveCSS("opacity", "1");
	await expect(page.getByTestId("os-home-intro")).toHaveCSS("opacity", "0", {
		timeout: 8000,
	});
	const dockArtwork = page
		.getByTestId("os-dock-mission-control")
		.locator('[data-app-icon="layered"] img');
	await expect(dockArtwork).toHaveCount(2);
	const artworkSources = await dockArtwork.evaluateAll((images) =>
		images.map((image) => image.getAttribute("src"))
	);
	await page.getByTestId("os-dock-app-launcher").click();
	const launcherArtwork = page
		.getByTestId("app-launcher-app-mission-control")
		.locator('[data-app-icon="layered"] img');
	await expect(launcherArtwork).toHaveCount(2);
	expect(
		await launcherArtwork.evaluateAll((images) =>
			images.map((image) => image.getAttribute("src"))
		)
	).toEqual(artworkSources);
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Customize desktop", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "Customize desktop" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("switch", { name: "Seconds", exact: true }).check();
	await dialog
		.getByRole("switch", { name: "24-hour time", exact: true })
		.check();
	await dialog
		.getByRole("switch", { name: "Welcome text", exact: true })
		.uncheck();
	await dialog.getByRole("switch", { name: "Date", exact: true }).uncheck();
	await page.keyboard.press("Escape");
	const clock = page.getByTestId("os-home-clock");
	await expect(clock).toHaveText(/^\d{1,2}:\d{2}:\d{2}$/);
	const initial = await clock.textContent();
	await expect(clock).not.toHaveText(initial ?? "");
	await expect(page.getByTestId("os-home-date")).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId("os-home-intro")).toHaveCount(0);
	await expect(page.getByTestId("os-home-date")).toHaveCount(0);
	await expect(page.getByTestId("os-home-clock")).toHaveText(
		/^\d{1,2}:\d{2}:\d{2}$/
	);
	await page
		.getByRole("button", { name: "Customize desktop", exact: true })
		.click();
	await page.getByRole("switch", { name: "Date", exact: true }).check();
	await page.getByRole("switch", { name: "Seconds", exact: true }).uncheck();
	await expect(
		page.getByText("Connection restored", { exact: true })
	).toBeHidden({ timeout: 10_000 });
	await page.screenshot({
		path: "e2e/artifacts/os-home-customization.png",
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await page.screenshot({
		path: "e2e/artifacts/os-home-clock.png",
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Customize desktop", exact: true })
		.click();
	await page.getByRole("switch", { name: "Clock", exact: true }).uncheck();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("os-home-clock")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("nested clipping, lazy pages and auto-hide preserve geometry and scroll", async ({
	page,
}) => {
	await page.goto("/titlebar-glass-proof.html?geometry=1");
	await page.getByRole("button", { name: "Load page", exact: true }).click();
	const frame = page.getByTestId("geometry-frame");
	const scroller = page.getByTestId("nested-scroll");
	const footer = page.getByTestId("footer");
	await expect
		.poll(async () =>
			Math.abs(
				(await scroller.boundingBox())!.y - (await frame.boundingBox())!.y
			)
		)
		.toBeLessThan(1);
	const bottom =
		(await footer.boundingBox())!.y + (await footer.boundingBox())!.height;
	expect(
		Math.abs(bottom - ((await frame.boundingBox())!.y + 500))
	).toBeLessThan(1);
	await scroller.evaluate((el) => {
		el.scrollTop = 190;
	});
	await page
		.getByRole("button", { name: "Toggle clearance", exact: true })
		.click();
	await expect(scroller).toHaveCSS("padding-top", "0px");
	await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(190);
	await page
		.getByRole("button", { name: "Toggle clearance", exact: true })
		.click();
	await expect
		.poll(() =>
			scroller.evaluate((el) =>
				Number.parseFloat(getComputedStyle(el).paddingTop)
			)
		)
		.toBeGreaterThan(60);
	await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(190);
	expect(
		Math.abs(
			(await footer.boundingBox())!.y +
				(await footer.boundingBox())!.height -
				bottom
		)
	).toBeLessThan(1);
	await scroller.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(page.getByText("Row 30", { exact: true })).toBeInViewport();
});

test("Store, Library and Settings keep their first controls below the glass", async ({
	page,
}) => {
	await page.goto("/titlebar-glass-proof.html");
	// The harness restores the /store tab under its own title, "Store"; the
	// marketplace surface is what the tab renders.
	for (const label of ["Store", "Library", "Settings"]) {
		await page
			.locator("[data-tab-appearance][data-tauri-drag-region]")
			.getByRole("button", { name: label, exact: true })
			.click();
		const frame = page.locator("[data-titlebar-page]:visible");
		const content =
			label === "Store"
				? frame.locator('[data-slot="marketplace-surface"]')
				: label === "Settings"
					? frame.getByRole("heading", { name: "Settings", exact: true })
					: frame.locator("input").first();
		await expect(content).toBeVisible();
		const glass = page
			.locator(
				"[data-tab-appearance][data-tauri-drag-region] > .pointer-events-none"
			)
			.first();
		const box = await glass.boundingBox();
		expect((await content.boundingBox())!.y).toBeGreaterThanOrEqual(
			box!.y + box!.height - 1
		);
	}
});
