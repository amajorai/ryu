import { expect, type Locator, type Page, test } from "@playwright/test";

// Settings → Appearance → Backgrounds, driven in a real Chromium against the
// existing background-customization harness (the REAL AppearanceTab plus the
// app's boot-time initBackgroundCustomization and src/index.css). Effects are
// read where the app paints them: the CSS custom properties on <html>, the
// `data-ryu-bg-active` routing flag, and the computed ::before layer of the
// selectors the shipping sidebar ([data-slot="sidebar-inner"]) and page
// ([data-slot="sidebar-inset"]) surfaces use. Image bytes are read back from
// the real IndexedDB store.

/** The payload Playwright's file chooser accepts (not exported by name). */
interface FilePayload {
	buffer: Buffer;
	mimeType: string;
	name: string;
}

const STORY_URL = "/background-customization-proof.html";
const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64"
);
const IMAGE_FILE: FilePayload = {
	buffer: PIXEL_PNG,
	mimeType: "image/png",
	name: "ibk-pixel.png",
};
const UNRELATED_KEY = "ibk:unrelated-record";
const UNRELATED_VALUE = JSON.stringify({ keep: true });

type Surface = "page" | "sidebar";

interface StoredBackground {
	backdropBlur?: number;
	gradientAngle?: number;
	gradientEnabled?: boolean;
	imageEnabled?: boolean;
	imageFit?: string;
	imageScale?: number;
	imageSrc?: string;
	overlayColor?: string;
	overlayOpacity?: number;
	transparency?: number;
}

interface PaintedLayer {
	backgroundImage: string;
	backgroundPosition: string;
	backgroundRepeat: string;
	backgroundSize: string;
	filter: string;
	opacity: string;
}

test.describe.configure({ timeout: 90_000 });

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(
		({ key, value }) => {
			if (localStorage.getItem(key) === null) {
				localStorage.setItem(key, value);
			}
		},
		{ key: UNRELATED_KEY, value: UNRELATED_VALUE }
	);
	await page.setViewportSize({ height: 1000, width: 1440 });
});
test.afterEach(async ({ page }) => {
	expect(pageErrors.get(page)).toEqual([]);
	// An unrelated record in the same storage is never touched.
	expect(
		await page.evaluate((key) => localStorage.getItem(key), UNRELATED_KEY)
	).toBe(UNRELATED_VALUE);
});

/** Mount the two surface selectors the shipping layout paints through. */
async function mountSurfaceProbes(page: Page) {
	await page.evaluate(() => {
		for (const slot of ["sidebar-inner", "sidebar-inset"]) {
			if (document.querySelector(`[data-ibk-probe="${slot}"]`)) {
				continue;
			}
			const probe = document.createElement("div");
			probe.dataset.slot = slot;
			probe.dataset.ibkProbe = slot;
			probe.style.position = "relative";
			probe.style.width = "40px";
			probe.style.height = "40px";
			document.body.append(probe);
		}
	});
}

async function load(page: Page) {
	await page.goto(STORY_URL);
	await expect(
		page.getByTestId("background-customization-proof")
	).toBeVisible();
	await mountSurfaceProbes(page);
}

async function openBackgrounds(page: Page) {
	await page
		.getByRole("button", { name: "Layout & text", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Backgrounds", exact: true })
	).toBeVisible();
}

function column(page: Page, surface: Surface): Locator {
	return page
		.getByRole("heading", {
			exact: true,
			name: surface === "sidebar" ? "Sidebar" : "Page background",
		})
		.locator("xpath=..");
}

async function stored(page: Page, surface: Surface) {
	return page.evaluate((key) => {
		const raw = localStorage.getItem(`ryu:bg:${key}`);
		return raw ? (JSON.parse(raw) as StoredBackground) : null;
	}, surface);
}

async function cssVar(page: Page, surface: Surface, part: string) {
	return page.evaluate(
		(name) => document.documentElement.style.getPropertyValue(name).trim(),
		`--ryu-${surface}-bg-${part}`
	);
}

async function painted(page: Page, surface: Surface): Promise<PaintedLayer> {
	return page.evaluate(
		(slot) => {
			const probe = document.querySelector(`[data-ibk-probe="${slot}"]`);
			if (!probe) {
				throw new Error(`missing ${slot} probe`);
			}
			const layer = getComputedStyle(probe, "::before");
			return {
				backgroundImage: layer.backgroundImage,
				backgroundPosition: layer.backgroundPosition,
				backgroundRepeat: layer.backgroundRepeat,
				backgroundSize: layer.backgroundSize,
				filter: layer.filter,
				opacity: layer.opacity,
			};
		},
		surface === "sidebar" ? "sidebar-inner" : "sidebar-inset"
	);
}

async function rootActive(page: Page) {
	return page.evaluate(() =>
		document.documentElement.getAttribute("data-ryu-bg-active")
	);
}

async function storedImage(page: Page, surface: Surface) {
	return page.evaluate(
		(key) =>
			new Promise<number[] | null>((resolve, reject) => {
				const request = indexedDB.open("ryu-backgrounds", 1);
				request.onerror = () => reject(request.error);
				request.onupgradeneeded = () => {
					if (!request.result.objectStoreNames.contains("images")) {
						request.result.createObjectStore("images");
					}
				};
				request.onsuccess = () => {
					const database = request.result;
					const read = database
						.transaction("images", "readonly")
						.objectStore("images")
						.get(key);
					read.onerror = () => reject(read.error);
					read.onsuccess = async () => {
						const blob = read.result;
						database.close();
						resolve(
							blob instanceof Blob
								? Array.from(new Uint8Array(await blob.arrayBuffer()))
								: null
						);
					};
				};
			}),
		surface
	);
}

async function pressOn(page: Page, control: Locator, key: string, times = 1) {
	await control.focus();
	for (let step = 0; step < times; step += 1) {
		await page.keyboard.press(key);
	}
}

async function chooseFit(page: Page, label: string) {
	const fit = page.getByRole("combobox", { name: "Sidebar image fit" });
	await fit.click();
	await page.getByRole("option", { name: label, exact: true }).click();
	await expect(fit).toContainText(label);
	await expect(page.locator('[role="listbox"]:visible')).toHaveCount(0);
}

test("Angle redraws only the sidebar's gradient layer, is restored by the boot path after reload, and leaves the page surface untouched", async ({
	page,
}) => {
	await load(page);
	await openBackgrounds(page);
	expect(await rootActive(page)).toBeNull();
	await page
		.getByRole("switch", { name: "Sidebar gradient background" })
		.click();
	await expect.poll(() => rootActive(page)).toBe("true");
	expect((await painted(page, "sidebar")).backgroundImage).toContain(
		"linear-gradient(135deg"
	);

	const sidebar = column(page, "sidebar");
	const angle = sidebar.getByRole("slider", { name: "Angle", exact: true });
	await expect(angle).toHaveAttribute("aria-valuenow", "135");
	await pressOn(page, angle, "ArrowRight", 10);
	await expect(angle).toHaveAttribute("aria-valuenow", "145");
	await expect
		.poll(async () => (await stored(page, "sidebar"))?.gradientAngle)
		.toBe(145);
	expect(await cssVar(page, "sidebar", "image")).toBe(
		"linear-gradient(145deg, rgba(0, 153, 255, 1) 0%, rgba(124, 58, 237, 1) 100%)"
	);
	await expect
		.poll(async () => (await painted(page, "sidebar")).backgroundImage)
		.toBe(
			"linear-gradient(145deg, rgb(0, 153, 255) 0%, rgb(124, 58, 237) 100%)"
		);
	const preview = sidebar.getByRole("img", { name: "Gradient preview" });
	expect(
		await preview.evaluate(
			(element) => getComputedStyle(element).backgroundImage
		)
	).toContain("145deg");
	await pressOn(page, angle, "End");
	await expect(angle).toHaveAttribute("aria-valuenow", "360");
	await expect.poll(() => cssVar(page, "sidebar", "image")).toContain("360deg");

	// The other surface is not painted and holds no saved config.
	expect(await cssVar(page, "page", "image")).toBe("");
	expect((await painted(page, "page")).backgroundImage).toBe("none");
	expect(await stored(page, "page")).toBeNull();
	await expect(
		column(page, "page").getByRole("slider", { name: "Angle", exact: true })
	).toHaveCount(0);

	// Boot re-applies the saved layer before Settings is even opened.
	await page.reload();
	await mountSurfaceProbes(page);
	await expect.poll(() => cssVar(page, "sidebar", "image")).toContain("360deg");
	expect((await painted(page, "sidebar")).backgroundImage).toContain("360deg");
	expect(await rootActive(page)).toBe("true");
	await openBackgrounds(page);
	await expect(
		column(page, "sidebar").getByRole("slider", { name: "Angle", exact: true })
	).toHaveAttribute("aria-valuenow", "360");
});

test("Fit, Scale, Overlay color and Overlay opacity reshape the image layer the surface paints; Remove image deletes the stored bytes and keeps the gradient", async ({
	page,
}) => {
	await load(page);
	await openBackgrounds(page);
	const sidebar = column(page, "sidebar");
	await page
		.getByRole("switch", { name: "Sidebar gradient background" })
		.click();
	await page.getByRole("switch", { name: "Sidebar image background" }).click();
	await expect(
		sidebar.getByText("Choose an image to set its fit, scale, and overlay.")
	).toBeVisible();
	const chooser = page.waitForEvent("filechooser");
	await sidebar
		.getByRole("button", { name: "Choose image", exact: true })
		.click();
	await (await chooser).setFiles(IMAGE_FILE);
	await expect(
		sidebar.getByRole("button", { name: "Replace", exact: true })
	).toBeVisible();
	await expect
		.poll(() => storedImage(page, "sidebar"))
		.toEqual(Array.from(PIXEL_PNG));

	// Default: overlay tint (30% black) over a cover image over the gradient.
	await expect
		.poll(() => cssVar(page, "sidebar", "image"))
		.toMatch(
			/^linear-gradient\(rgba\(0, 0, 0, 0\.3\), rgba\(0, 0, 0, 0\.3\)\), url\("blob:[^"]+"\), linear-gradient\(135deg/
		);
	expect(await cssVar(page, "sidebar", "size")).toBe("cover, cover, cover");
	await expect(
		sidebar.getByRole("slider", { name: "Scale", exact: true })
	).toHaveCount(0);

	await chooseFit(page, "Tile");
	await expect
		.poll(async () => (await stored(page, "sidebar"))?.imageFit)
		.toBe("tile");
	expect(await cssVar(page, "sidebar", "size")).toBe("cover, 100%, cover");
	expect(await cssVar(page, "sidebar", "repeat")).toBe(
		"no-repeat, repeat, no-repeat"
	);
	expect(await cssVar(page, "sidebar", "position")).toBe(
		"center, top left, center"
	);
	const painting = await painted(page, "sidebar");
	expect(painting.backgroundRepeat).toBe("no-repeat, repeat, no-repeat");
	expect(painting.backgroundSize).toBe("cover, 100%, cover");

	const scale = sidebar.getByRole("slider", { name: "Scale", exact: true });
	await expect(scale).toHaveAttribute("aria-valuenow", "100");
	await pressOn(page, scale, "ArrowRight", 2);
	await expect(scale).toHaveAttribute("aria-valuenow", "110");
	await expect
		.poll(async () => (await stored(page, "sidebar"))?.imageScale)
		.toBe(110);
	expect(await cssVar(page, "sidebar", "size")).toBe("cover, 110%, cover");
	expect((await painted(page, "sidebar")).backgroundSize).toBe(
		"cover, 110%, cover"
	);

	await chooseFit(page, "Stretch");
	expect(await cssVar(page, "sidebar", "size")).toBe("cover, 100% 100%, cover");
	await expect(scale).toHaveCount(0);
	await chooseFit(page, "Contain");
	expect(await cssVar(page, "sidebar", "size")).toBe("cover, contain, cover");

	await sidebar.getByRole("button", { name: "Overlay color" }).click();
	await page
		.getByRole("textbox", { name: "Hex color value" })
		.last()
		.fill("#3388EE");
	await page.keyboard.press("Escape");
	await expect
		.poll(async () => (await stored(page, "sidebar"))?.overlayColor)
		.toBe("#3388EE");
	await expect
		.poll(() => cssVar(page, "sidebar", "image"))
		.toMatch(
			/^linear-gradient\(rgba\(51, 136, 238, 0\.3\), rgba\(51, 136, 238, 0\.3\)\)/
		);

	const overlayOpacity = sidebar.getByRole("slider", {
		name: "Overlay opacity",
	});
	await pressOn(page, overlayOpacity, "End");
	await expect
		.poll(async () => (await stored(page, "sidebar"))?.overlayOpacity)
		.toBe(100);
	expect(await cssVar(page, "sidebar", "image")).toMatch(
		/^linear-gradient\(rgba\(51, 136, 238, 1\), rgba\(51, 136, 238, 1\)\)/
	);
	// No tint at 0%: the overlay layer is dropped, the image is the top layer.
	await pressOn(page, overlayOpacity, "Home");
	await expect
		.poll(async () => (await stored(page, "sidebar"))?.overlayOpacity)
		.toBe(0);
	expect(await cssVar(page, "sidebar", "image")).toMatch(
		/^url\("blob:[^"]+"\), linear-gradient\(135deg/
	);
	expect(await cssVar(page, "sidebar", "size")).toBe("contain, cover");

	await sidebar
		.getByRole("button", { name: "Remove image", exact: true })
		.click();
	await expect.poll(() => storedImage(page, "sidebar")).toBeNull();
	await expect
		.poll(() => cssVar(page, "sidebar", "image"))
		.toBe(
			"linear-gradient(135deg, rgba(0, 153, 255, 1) 0%, rgba(124, 58, 237, 1) 100%)"
		);
	await expect(
		sidebar.getByRole("button", { name: "Choose image", exact: true })
	).toBeVisible();
	await expect(
		sidebar.getByRole("combobox", { name: "Sidebar image fit" })
	).toHaveCount(0);
	expect(await stored(page, "sidebar")).toMatchObject({
		gradientEnabled: true,
		imageEnabled: true,
		imageFit: "contain",
		overlayColor: "#3388EE",
		overlayOpacity: 0,
	});
	expect((await stored(page, "sidebar"))?.imageSrc).toBeUndefined();
	// Page surface never received any of the sidebar's edits.
	expect(await stored(page, "page")).toBeNull();
	expect(await storedImage(page, "page")).toBeNull();

	await page.reload();
	await mountSurfaceProbes(page);
	await expect
		.poll(() => cssVar(page, "sidebar", "image"))
		.toContain("linear-gradient(135deg");
	expect(await cssVar(page, "sidebar", "image")).not.toContain("blob:");
	await openBackgrounds(page);
	await expect(
		column(page, "sidebar").getByRole("button", {
			name: "Choose image",
			exact: true,
		})
	).toBeVisible();
});

test("Transparency and Backdrop blur frost the page surface with no gradient or image, route it through the layer, survive reload, and clear the routing at zero", async ({
	page,
}) => {
	await load(page);
	await openBackgrounds(page);
	const pageColumn = column(page, "page");
	expect(await rootActive(page)).toBeNull();
	const before = await painted(page, "page");
	expect(before.opacity).toBe("1");
	expect(before.filter).toBe("blur(0px)");

	const transparency = pageColumn.getByRole("slider", {
		name: "Transparency",
		exact: true,
	});
	await pressOn(page, transparency, "ArrowRight", 25);
	await expect(transparency).toHaveAttribute("aria-valuenow", "25");
	await expect
		.poll(async () => (await stored(page, "page"))?.transparency)
		.toBe(25);
	expect(await cssVar(page, "page", "opacity")).toBe("0.75");
	await expect
		.poll(async () => (await painted(page, "page")).opacity)
		.toBe("0.75");
	expect(await rootActive(page)).toBe("true");
	// While routed, the surface's own colour steps aside for the ::before layer.
	expect(
		await page.evaluate(
			() =>
				getComputedStyle(
					document.querySelector('[data-ibk-probe="sidebar-inset"]')!
				).backgroundColor
		)
	).toBe("rgba(0, 0, 0, 0)");

	const blur = pageColumn.getByRole("slider", {
		name: "Backdrop blur",
		exact: true,
	});
	await pressOn(page, blur, "End");
	await expect(blur).toHaveAttribute("aria-valuenow", "60");
	await expect
		.poll(async () => (await stored(page, "page"))?.backdropBlur)
		.toBe(60);
	expect(await cssVar(page, "page", "blur")).toBe("60px");
	await expect
		.poll(async () => (await painted(page, "page")).filter)
		.toBe("blur(60px)");
	// No gradient or image was enabled: only the effects are applied.
	expect(await cssVar(page, "page", "image")).toBe("");
	// The sidebar keeps its untouched defaults.
	expect(await cssVar(page, "sidebar", "opacity")).toBe("1");
	expect(await cssVar(page, "sidebar", "blur")).toBe("0px");

	await page.reload();
	await mountSurfaceProbes(page);
	await expect.poll(() => cssVar(page, "page", "opacity")).toBe("0.75");
	expect((await painted(page, "page")).filter).toBe("blur(60px)");
	expect(await rootActive(page)).toBe("true");
	await openBackgrounds(page);
	const reloadedColumn = column(page, "page");
	const reloadedTransparency = reloadedColumn.getByRole("slider", {
		name: "Transparency",
		exact: true,
	});
	const reloadedBlur = reloadedColumn.getByRole("slider", {
		name: "Backdrop blur",
		exact: true,
	});
	await expect(reloadedTransparency).toHaveAttribute("aria-valuenow", "25");
	await expect(reloadedBlur).toHaveAttribute("aria-valuenow", "60");

	await pressOn(page, reloadedTransparency, "Home");
	await expect.poll(() => cssVar(page, "page", "opacity")).toBe("1");
	expect(await rootActive(page)).toBe("true");
	await pressOn(page, reloadedBlur, "Home");
	await expect.poll(() => cssVar(page, "page", "blur")).toBe("0px");
	await expect.poll(() => rootActive(page)).toBeNull();
	expect(await stored(page, "page")).toMatchObject({
		backdropBlur: 0,
		transparency: 0,
	});
});
