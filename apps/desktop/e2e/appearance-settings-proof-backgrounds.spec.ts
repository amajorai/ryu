import { expect, test } from "@playwright/test";
import { appearanceBackgroundProofSchema } from "./appearance-proof.contracts.ts";
import {
	openPage,
	readStoredAppearanceDocument,
	STORY_URL,
	selectOption,
} from "./appearance-settings-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("gradient and image backgrounds edit, persist, and clear on both surfaces", async ({
	page,
}, testInfo) => {
	page.setDefaultTimeout(20_000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Layout & text");

	const readBackground = async (surface: "page" | "sidebar") => {
		const value = await readStoredAppearanceDocument(page, `ryu:bg:${surface}`);
		return value === null ? null : appearanceBackgroundProofSchema.parse(value);
	};
	const switches = page.getByRole("switch");
	await expect(switches).toHaveCount(4);
	const backgroundSwitches = [
		[0, "sidebar", "gradientEnabled"],
		[1, "sidebar", "imageEnabled"],
		[2, "page", "gradientEnabled"],
		[3, "page", "imageEnabled"],
	] as const;
	for (const [index, surface, property] of backgroundSwitches) {
		const control = switches.nth(index);
		await control.click();
		await expect(control).toBeChecked();
		await expect
			.poll(async () => (await readBackground(surface))?.[property])
			.toBe(true);
	}

	const addStops = page.getByRole("button", { name: "Add stop", exact: true });
	await expect(addStops).toHaveCount(2);
	for (const surface of ["sidebar", "page"] as const) {
		const stopCount = (await readBackground(surface))?.gradientStops;
		if (!stopCount) {
			throw new Error(
				"The saved native background must contain its gradient stops"
			);
		}
		const addButton = addStops.nth(surface === "sidebar" ? 0 : 1);
		await addButton.click();
		await expect
			.poll(async () => {
				const value = await readBackground(surface);
				return value?.gradientStops?.length ?? 0;
			})
			.toBe(stopCount.length + 1);
		await page
			.getByRole("button", { name: "Remove gradient stop 3" })
			.last()
			.click();
		await expect
			.poll(async () => {
				const value = await readBackground(surface);
				return value?.gradientStops?.length ?? 0;
			})
			.toBe(stopCount.length);
	}

	const gradientStopColor = page.getByRole("button", {
		name: "Gradient stop 1 color",
	});
	await gradientStopColor.first().click();
	const gradientHex = page.getByRole("textbox", { name: "Hex color value" });
	await gradientHex.fill("#00CC88");
	await expect
		.poll(async () => {
			const value = await readBackground("sidebar");
			const stops = value?.gradientStops;
			return stops?.[0]?.color;
		})
		.toBe("#00CC88");
	await page.keyboard.press("Escape");

	const angle = page.getByRole("slider", { name: "Angle" }).first();
	const angleBefore = (await readBackground("sidebar"))?.gradientAngle ?? null;
	await angle.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(async () => (await readBackground("sidebar"))?.gradientAngle)
		.not.toBe(angleBefore);

	const file = {
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64"
		),
		mimeType: "image/png",
		name: "pixel.png",
	};
	for (const surface of ["sidebar", "page"] as const) {
		const chooseButton = page.getByRole("button", {
			name: "Choose image",
			exact: true,
		});
		if (surface === "page") {
			const invalidChooserPromise = page.waitForEvent("filechooser");
			await chooseButton.first().click();
			const invalidChooser = await invalidChooserPromise;
			await invalidChooser.setFiles({
				buffer: Buffer.from("not an image"),
				mimeType: "text/plain",
				name: "notes.txt",
			});
			await expect(
				page.getByText("Please choose an image file.", { exact: true })
			).toBeVisible();
			await expect
				.poll(async () => (await readBackground(surface))?.imageEnabled)
				.toBe(true);
		}
		const chooserPromise = page.waitForEvent("filechooser");
		await chooseButton.first().click();
		const chooser = await chooserPromise;
		await chooser.setFiles(file);
		await expect
			.poll(async () => (await readBackground(surface))?.imageEnabled)
			.toBe(true);
		await expect(
			page.getByRole("button", { name: "Replace", exact: true })
		).toHaveCount(surface === "sidebar" ? 1 : 2);
	}

	const fitOptions = [
		["Cover", "cover"],
		["Contain", "contain"],
		["Stretch", "fill"],
		["Center", "center"],
		["Tile", "tile"],
	] as const;
	for (const [fitIndex, surface] of (["sidebar", "page"] as const).entries()) {
		const fit = page.getByRole("combobox").nth(fitIndex);
		for (const [label, value] of fitOptions) {
			await selectOption(page, fit, label);
			await expect
				.poll(async () => (await readBackground(surface))?.imageFit)
				.toBe(value);
		}
	}

	const scaleSliders = page.getByRole("slider", { exact: true, name: "Scale" });
	await expect(scaleSliders).toHaveCount(2);
	for (const [index, surface] of (["sidebar", "page"] as const).entries()) {
		const slider = scaleSliders.nth(index);
		const before = (await readBackground(surface))?.imageScale;
		await slider.focus();
		await page.keyboard.press("ArrowRight");
		await expect
			.poll(async () => (await readBackground(surface))?.imageScale)
			.not.toBe(before);
	}

	const overlayColors = page.getByRole("button", { name: "Overlay color" });
	for (const [index, surface] of (["sidebar", "page"] as const).entries()) {
		await overlayColors.nth(index).click();
		const overlayHex = page
			.getByRole("textbox", { name: "Hex color value" })
			.last();
		const color = index === 0 ? "#EE6633" : "#3388EE";
		await overlayHex.fill(color);
		await expect
			.poll(async () => (await readBackground(surface))?.overlayColor)
			.toBe(color);
		await page.keyboard.press("Escape");
	}

	const overlayOpacity = page.getByRole("slider", { name: "Overlay opacity" });
	await expect(overlayOpacity).toHaveCount(2);
	for (const [index, surface] of (["sidebar", "page"] as const).entries()) {
		const before = (await readBackground(surface))?.overlayOpacity;
		const control = overlayOpacity.nth(index);
		await control.focus();
		await page.keyboard.press("ArrowRight");
		await expect
			.poll(async () => (await readBackground(surface))?.overlayOpacity)
			.not.toBe(before);
	}

	for (const label of ["Transparency", "Backdrop blur"] as const) {
		const controls = page.getByRole("slider", { name: label });
		await expect(controls).toHaveCount(2);
		for (const [index, surface] of (["sidebar", "page"] as const).entries()) {
			const property =
				label === "Transparency" ? "transparency" : "backdropBlur";
			const control = controls.nth(index);
			const before = (await readBackground(surface))?.[property];
			await control.focus();
			await page.keyboard.press("ArrowRight");
			await expect
				.poll(async () => (await readBackground(surface))?.[property])
				.not.toBe(before);
		}
	}

	await page.getByRole("button", { name: "Remove image" }).nth(1).click();
	await expect(
		page.getByRole("button", { name: "Choose image", exact: true })
	).toHaveCount(1);
	await page.getByRole("button", { name: "Remove image" }).first().click();
	await expect(
		page.getByRole("button", { name: "Choose image", exact: true })
	).toHaveCount(2);
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue("--ryu-page-bg-image")
			)
		)
		.not.toContain("url(");
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue(
					"--ryu-sidebar-bg-image"
				)
			)
		)
		.not.toContain("url(");
	await expect(
		page.getByText("Please choose an image file.", { exact: true })
	).toBeHidden();
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("desktop-appearance-backgrounds.png"),
	});
});
