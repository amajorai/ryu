import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";

/** The payload Playwright's file chooser accepts (not exported by name). */
interface FilePayload {
	buffer: Buffer;
	mimeType: string;
	name: string;
}

const STORY_URL = "/background-customization-proof.html";
// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
const EVIDENCE_DIR = process.env.RYU_PROOF_OUTPUT_ROOT
	? `${process.env.RYU_PROOF_OUTPUT_ROOT.replace(/\/+$/, "")}/`
	: fileURLToPath(
			new URL(
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/",
				import.meta.url
			)
		);

const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64"
);
const IMAGE_FILE: FilePayload = {
	buffer: PIXEL_PNG,
	mimeType: "image/png",
	name: "background-pixel.png",
};

type Surface = "page" | "sidebar";

interface StoredImageProof {
	bytes: number[];
	mimeType: string;
}

declare global {
	interface Window {
		__backgroundCustomizationProof?: {
			failNextOpen: () => void;
		};
	}
}

async function openBackgrounds(page: Page) {
	await page
		.getByRole("button", { name: "Layout & text", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Backgrounds", exact: true })
	).toBeVisible();
}

async function returnToAppearance(page: Page) {
	await page.getByRole("button", { name: "Appearance", exact: true }).click();
}

const backgroundSchema = z.object({
	backdropBlur: z.number().optional(),
	gradientAngle: z.number().optional(),
	gradientEnabled: z.boolean().optional(),
	gradientStops: z
		.array(z.object({ color: z.string(), position: z.number() }))
		.optional(),
	imageEnabled: z.boolean().optional(),
	imageFit: z.string().optional(),
	imageSrc: z.string().optional(),
});
async function storedBackground(page: Page, surface: Surface) {
	const raw = await page.evaluate(
		(key) => localStorage.getItem(`ryu:bg:${key}`),
		surface
	);
	return raw ? backgroundSchema.parse(JSON.parse(raw)) : null;
}

async function storedImage(
	page: Page,
	surface: Surface
): Promise<StoredImageProof | null> {
	const image = await page.evaluate(
		async (key) =>
			new Promise<StoredImageProof | null>((resolve, reject) => {
				const request = indexedDB.open("ryu-backgrounds", 1);
				request.onerror = () => reject(request.error);
				request.onupgradeneeded = () => {
					if (!request.result.objectStoreNames.contains("images")) {
						request.result.createObjectStore("images");
					}
				};
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction("images", "readonly");
					const read = transaction.objectStore("images").get(key);
					read.onerror = () => {
						database.close();
						reject(read.error);
					};
					read.onsuccess = async () => {
						const blob = read.result;
						if (!(blob instanceof Blob)) {
							database.close();
							resolve(null);
							return;
						}
						const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
						database.close();
						resolve({ bytes, mimeType: blob.type });
					};
				};
			}),
		surface
	);
	return image;
}

async function chooseImage(page: Page, file: FilePayload, buttonIndex = 0) {
	const chooserPromise = page.waitForEvent("filechooser");
	await page
		.getByRole("button", { name: "Choose image", exact: true })
		.nth(buttonIndex)
		.click();
	const chooser = await chooserPromise;
	await chooser.setFiles(file);
}

async function installIndexedDbFailureFixture(page: Page) {
	await page.addInitScript(() => {
		let failNextOpen = false;
		const originalOpen = indexedDB.open.bind(indexedDB);
		Object.defineProperty(indexedDB, "open", {
			configurable: true,
			value: (name: string, version?: number) => {
				if (name === "ryu-backgrounds" && failNextOpen) {
					failNextOpen = false;
					throw new DOMException(
						"Fixture IndexedDB open failure",
						"UnknownError"
					);
				}
				return version === undefined
					? originalOpen(name)
					: originalOpen(name, version);
			},
		});
		window.__backgroundCustomizationProof = {
			failNextOpen: () => {
				failNextOpen = true;
			},
		};
	});
}

test.describe.configure({ timeout: 90_000 });

test("gradient stop position updates the live preview and restores after reload", async ({
	page,
}) => {
	await installIndexedDbFailureFixture(page);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await expect(
		page.getByTestId("background-customization-proof")
	).toBeVisible();
	await openBackgrounds(page);

	const sidebarGradient = page.getByRole("switch", {
		name: "Sidebar gradient background",
	});
	const pageGradient = page.getByRole("switch", {
		name: "Page gradient background",
	});
	await expect(sidebarGradient).not.toBeChecked();
	await expect(pageGradient).not.toBeChecked();
	await sidebarGradient.click();
	await expect(sidebarGradient).toBeChecked();

	const slider = page.getByRole("slider", {
		name: "Gradient stop 1 position",
	});
	await expect(slider).toHaveAttribute("aria-valuenow", "0");
	await slider.focus();
	for (let step = 0; step < 17; step += 1) {
		await page.keyboard.press("ArrowRight");
	}
	await expect(slider).toHaveAttribute("aria-valuenow", "17");
	await expect
		.poll(
			async () => (await storedBackground(page, "sidebar"))?.gradientStops?.[0]
		)
		.toEqual({ color: "#0099ff", position: 17 });
	const preview = page.getByRole("img", { name: "Gradient preview" }).first();
	await expect
		.poll(() =>
			preview.evaluate((element) => getComputedStyle(element).backgroundImage)
		)
		.toContain("17%");
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-background-customization-gradient-position.png`,
	});

	await page.reload();
	await openBackgrounds(page);
	await expect(
		page.getByRole("switch", { name: "Sidebar gradient background" })
	).toBeChecked();
	await expect(
		page.getByRole("slider", { name: "Gradient stop 1 position" })
	).toHaveAttribute("aria-valuenow", "17");
});

test("image storage failure is announced, retry saves exact bytes, and reload hydrates the image", async ({
	page,
}) => {
	await installIndexedDbFailureFixture(page);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openBackgrounds(page);

	const imageSwitch = page.getByRole("switch", {
		name: "Sidebar image background",
	});
	await imageSwitch.click();
	await expect(imageSwitch).toBeChecked();
	await page.evaluate(() => {
		window.__backgroundCustomizationProof?.failNextOpen();
	});
	await chooseImage(page, IMAGE_FILE);
	await expect(
		page.getByText("Couldn't save that image.", { exact: true })
	).toBeVisible();
	await expect.poll(() => storedImage(page, "sidebar")).toBeNull();
	await expect(
		page.getByRole("button", { name: "Choose image", exact: true })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-background-customization-image-save-failure.png`,
	});

	await chooseImage(page, IMAGE_FILE);
	await expect(
		page.getByRole("button", { name: "Replace", exact: true })
	).toBeVisible();
	await expect
		.poll(() => storedImage(page, "sidebar"))
		.toEqual({
			bytes: Array.from(PIXEL_PNG),
			mimeType: "image/png",
		});
	await expect
		.poll(async () => (await storedBackground(page, "sidebar"))?.imageEnabled)
		.toBe(true);
	await expect
		.poll(async () => (await storedBackground(page, "sidebar"))?.imageSrc)
		.toBeUndefined();
	await expect
		.poll(() =>
			page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue(
					"--ryu-sidebar-bg-image"
				)
			)
		)
		.toContain("blob:");
	const fitSelector = page.getByRole("combobox", {
		name: "Sidebar image fit",
	});
	await expect(fitSelector).toContainText("Cover");
	await fitSelector.click();
	await page.getByRole("option", { name: "Contain", exact: true }).click();
	await expect(fitSelector).toContainText("Contain");
	await expect
		.poll(async () => (await storedBackground(page, "sidebar"))?.imageFit)
		.toBe("contain");

	await page.reload();
	await openBackgrounds(page);
	await expect(
		page.getByRole("button", { name: "Replace", exact: true })
	).toBeVisible();
	await expect
		.poll(() => storedImage(page, "sidebar"))
		.toEqual({
			bytes: Array.from(PIXEL_PNG),
			mimeType: "image/png",
		});
	await expect
		.poll(() =>
			page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue(
					"--ryu-sidebar-bg-image"
				)
			)
		)
		.toContain("blob:");
	await expect(
		page.getByRole("combobox", { name: "Sidebar image fit" })
	).toContainText("Contain");
	await expect(page.locator('[role="listbox"]:visible')).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-background-customization-image-saved.png`,
	});
});

test("remove and reset controls preserve cancel, clear local image bytes, and restore defaults", async ({
	page,
}) => {
	await installIndexedDbFailureFixture(page);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openBackgrounds(page);

	const sidebarGradient = page.getByRole("switch", {
		name: "Sidebar gradient background",
	});
	const pageGradient = page.getByRole("switch", {
		name: "Page gradient background",
	});
	const sidebarImage = page.getByRole("switch", {
		name: "Sidebar image background",
	});
	const pageImage = page.getByRole("switch", {
		name: "Page image background",
	});
	await sidebarGradient.click();
	await pageGradient.click();
	await sidebarImage.click();
	await pageImage.click();
	await chooseImage(page, IMAGE_FILE, 0);
	await expect(
		page.getByRole("button", { name: "Replace", exact: true })
	).toHaveCount(1);
	await chooseImage(page, IMAGE_FILE, 0);
	await expect(
		page.getByRole("button", { name: "Replace", exact: true })
	).toHaveCount(2);

	const removeButtons = page.getByRole("button", {
		name: "Remove image",
		exact: true,
	});
	await expect(removeButtons).toHaveCount(2);
	await removeButtons.first().click();
	await expect.poll(() => storedImage(page, "sidebar")).toBeNull();
	await expect(
		page.getByRole("button", { name: "Choose image", exact: true })
	).toHaveCount(1);
	await expect
		.poll(
			async () => (await storedBackground(page, "sidebar"))?.gradientEnabled
		)
		.toBe(true);

	await chooseImage(page, IMAGE_FILE, 0);
	await expect
		.poll(() => storedImage(page, "sidebar"))
		.toEqual({
			bytes: Array.from(PIXEL_PNG),
			mimeType: "image/png",
		});

	await returnToAppearance(page);
	await page.getByRole("button", { name: "Reset", exact: true }).click();
	const resetButton = page.getByRole("button", {
		name: "Reset to defaults",
		exact: true,
	});
	await resetButton.click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect
		.poll(
			async () => (await storedBackground(page, "sidebar"))?.gradientEnabled
		)
		.toBe(true);
	await expect
		.poll(() => storedImage(page, "sidebar"))
		.toEqual({
			bytes: Array.from(PIXEL_PNG),
			mimeType: "image/png",
		});

	await page
		.getByRole("button", { name: "Reset to defaults", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Confirm reset", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:bg:sidebar")))
		.toBeNull();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:bg:page")))
		.toBeNull();
	await expect.poll(() => storedImage(page, "sidebar")).toBeNull();
	await expect.poll(() => storedImage(page, "page")).toBeNull();

	await returnToAppearance(page);
	await openBackgrounds(page);
	await expect(
		page.getByRole("switch", { name: "Sidebar gradient background" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Page gradient background" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Sidebar image background" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Page image background" })
	).not.toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue(
					"--ryu-sidebar-bg-image"
				)
			)
		)
		.toBe("");
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIR}desktop-background-customization-reset-defaults.png`,
	});

	await page.reload();
	await openBackgrounds(page);
	await expect(
		page.getByRole("switch", { name: "Sidebar gradient background" })
	).not.toBeChecked();
	await expect.poll(() => storedImage(page, "sidebar")).toBeNull();
	await expect.poll(() => storedImage(page, "page")).toBeNull();
});
